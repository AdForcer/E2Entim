import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  PermissionsAndroid,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Image,
  ListRenderItemInfo,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import {
  HubConnectionBuilder,
  HubConnection,
  HubConnectionState,
} from '@microsoft/signalr';
import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '../uti/storage';
import { launchImageLibrary, Asset } from 'react-native-image-picker';
import RNFS from 'react-native-fs';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
//import { MMKV } from 'react-native-mmkv';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { Video as VideoCompressor } from 'react-native-compressor';
import { Buffer } from 'buffer';

// === ТИПЫ ===
interface ChatMessage {
  id: string;
  text: string;
  image?: string;
  video?: string;
  fromMe: boolean;
  timestamp: number;
}

// === КОНСТАНТЫ ===
const CHUNK_SIZE = 65000;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const IMAGE_DATA_PREFIX = 'data:image/';
const VIDEO_DATA_PREFIX = 'data:video/';
const MESSAGES_KEY = 'chat_messages_v2';

// ===== ЗАШИФРОВАННОЕ ХРАНИЛИЩЕ ==========================================
function saveMessages(msgs: ChatMessage[]) {
  if (!storage) return; // На всякий случай проверяем
  try {
    const toSave = msgs.slice(0, 300).map(m => ({
      ...m,
      image: m.image?.startsWith('file://') ? m.image : undefined,
      video: m.video?.startsWith('file://') ? m.video : undefined,
    }));
    storage.set(MESSAGES_KEY, JSON.stringify(toSave));
  } catch {}
}

function loadMessages(): ChatMessage[] {
  if (!storage) return [];
  try {
    const raw = storage.getString(MESSAGES_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ChatMessage[];
  } catch { return []; }
}

// === ШИФРОВАНИЕ =================================================
function encryptPayload(data: string, theirPubKey: string, mySecKey: string): string {
  const theirPub = decodeBase64(theirPubKey);
  const mySec = decodeBase64(mySecKey);
  const msgBytes = Buffer.from(data, 'utf-8');
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(msgBytes, nonce, theirPub, mySec);
  if (!encrypted) throw new Error('Encryption failed');
  const full = new Uint8Array(nonce.length + encrypted.length);
  full.set(nonce);
  full.set(encrypted, nonce.length);
  return encodeBase64(full);
}

function decryptPayload(payload: string, theirPubKey: string, mySecKey: string): string | null {
  try {
    const full = decodeBase64(payload);
    const nonce = full.slice(0, nacl.box.nonceLength);
    const box = full.slice(nacl.box.nonceLength);
    const theirPub = decodeBase64(theirPubKey);
    const mySec = decodeBase64(mySecKey);
    const decrypted = nacl.box.open(box, nonce, theirPub, mySec);
    if (!decrypted) return null;
    return Buffer.from(decrypted).toString('utf-8');
  } catch { return null; }
}

// === ПОТОКОВОЕ ШИФРОВАНИЕ ДЛЯ ВИДЕО ===
// Вычисляем один раз: общий симметричный ключ из DH-обмена
function getSharedKey(theirPubKey: string, mySecKey: string): Uint8Array {
  return nacl.box.before(decodeBase64(theirPubKey), decodeBase64(mySecKey));
}

function encryptChunk(bytes: Uint8Array, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(bytes, nonce, sharedKey);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce); out.set(box, nonce.length);
  return encodeBase64(out);
}

function decryptChunk(payload: string, sharedKey: Uint8Array): Uint8Array | null {
  try {
    const full = decodeBase64(payload);
    const nonce = full.slice(0, nacl.secretbox.nonceLength);
    const box = full.slice(nacl.secretbox.nonceLength);
    return nacl.secretbox.open(box, nonce, sharedKey);
  } catch { return null; }
}

// 160 KB сырых данных → где-то 218 KB base64 (+nonce +заголовок) — почти весь 256 KB лимит SignalR
// Крупные чанки - в разы меньше итераций и накладных расходов на сообщение
const VIDEO_CHUNK_BYTES = 160 * 1024;
const SEND_WINDOW = 6;        // сколько чанков держим в пути одновременно
const CHUNK_RETRIES = 4;      // попыток переотправки одного чанка при сбое
const RETRY_BASE_MS = 800;    // базовая пауза между попытками (растёт линейно)

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

// Отправка одного чанка через invoke() (с подтверждением сервера) + ретраи
// invoke ждёт ответа сервера, поэтому потеря чанка при реконнекте
// не остаётся незамеченной — мы её увидим и переотправим. Видео не соберётся битым молча
async function sendChunkReliable(
  conn: HubConnection,
  sender: string,
  recipient: string,
  payload: string,
): Promise<void> {

  const isLive = () => conn.state === HubConnectionState.Connected;
  let lastErr: unknown;
  for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
    try {
      if (!isLive()) {
        await delay(RETRY_BASE_MS * (attempt + 1));
        if (!isLive()) continue;
      }
      await conn.invoke('SendEncryptedMessage', sender, recipient, payload);
      return;
    } catch (e) {
      lastErr = e;
      await delay(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('chunk send failed');
}

// Оконная отправка: до SEND_WINDOW invoke() одновременно
// Скорость близка к fire-and-forget send(), но с гарантией доставки каждого чанка
async function sendVideoStream(
  conn: HubConnection,
  sender: string,
  recipient: string,
  fileUri: string,
  sharedKey: Uint8Array,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  const path = fileUri.replace('file://', '');
  const stat = await RNFS.stat(path);
  const fileSize = Number(stat.size);
  const totalChunks = Math.ceil(fileSize / VIDEO_CHUNK_BYTES);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let nextIdx = 0;
  let sentCount = 0;

  // Воркер берёт следующий индекс, читает+шифрует+отправляет, пока чанки не кончатся
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= totalChunks) return;
      const b64 = await RNFS.read(path, VIDEO_CHUNK_BYTES, i * VIDEO_CHUNK_BYTES, 'base64');
      const bytes = Buffer.from(b64, 'base64');
      const enc = encryptChunk(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), sharedKey);
      await sendChunkReliable(conn, sender, recipient, `__VSTM__${id}__${i}__${totalChunks}__${enc}`);
      sentCount++;
      onProgress?.(sentCount, totalChunks);
    }
  }

  const workers = Array.from({ length: Math.min(SEND_WINDOW, totalChunks) }, () => worker());
  // Если любой воркер бросит после всех ретраев — Promise.all отклонится, и мы покажем ошибку
  await Promise.all(workers);
}

// === ЧАНКОВАЯ ОТПРАВКА ===
async function sendChunked(
  conn: HubConnection,
  sender: string,
  recipient: string,
  encrypted: string,
): Promise<void> {
  const total = Math.ceil(encrypted.length / CHUNK_SIZE);
  if (total === 1) {
    await conn.send('SendEncryptedMessage', sender, recipient, encrypted);
    return;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < total; i++) {
    const chunk = encrypted.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await conn.send('SendEncryptedMessage', sender, recipient, `__CHUNK__${id}__${i}__${total}__${chunk}`);
  }
}

// === МЕДИА ХЕЛПЕРЫ ===
async function saveToTempFile(dataUri: string, prefix: string): Promise<string> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return dataUri;
  const [, mime, b64] = match;
  const ext = mime.includes('video') ? 'mp4' : mime.includes('png') ? 'png' : 'jpg';
  const path = `${RNFS.CachesDirectoryPath}/${prefix}_${Date.now()}.${ext}`;
  await RNFS.writeFile(path, b64, 'base64');
  return `file://${path}`;
}

async function saveToGallery(uri: string) {
  try {
    if (Platform.OS === 'android' && Platform.Version < 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert('Нет разрешения');
        return;
      }
    }
    await CameraRoll.saveAsset(uri, { type: 'auto' });
    Alert.alert('Сохранено в галерею');
  } catch {
    Alert.alert('Не удалось сохранить');
  }
}

async function pickMedia(
  onProgress?: (ratio: number) => void,
): Promise<{ uri: string; dataUri: string; type: 'image' | 'video' } | null> {
  const result = await launchImageLibrary({
    mediaType: 'mixed',
    quality: 0.6,
    includeBase64: true,
    maxWidth: 1024,
    maxHeight: 1024,
  });
  if (result.didCancel || result.errorCode) return null;
  const asset: Asset | undefined = result.assets?.[0];
  if (!asset) return null;

  const isVideo = asset.type?.startsWith('video/') ?? false;

  // === аппаратное сжатие ===
  if (isVideo) {
    if (!asset.uri) return null;
    // 720p, разумный битрейт — баланс качества и скорости.
    // Сжатие идёт ДО шифрования, поэтому E2EE не страдает
    const compressedUri = await VideoCompressor.compress(
      asset.uri,
      {
        compressionMethod: 'manual',
        maxSize: 1280,        // длинная сторона -> 720p-класс
        bitrate: 2_000_000,   // 2 Mbps, файл в примерно в 4-6 раз меньше
      },
      (progress: number) => onProgress?.(progress),
    );
    // dataUri для видео не используем, но поле обязательно
    return { uri: compressedUri, dataUri: '', type: 'video' };
  }

  // === ФОТО =============================================================
  if (asset.fileSize && asset.fileSize > MAX_IMAGE_SIZE) {
    Alert.alert('Фото слишком большое (макс 5 МБ)');
    return null;
  }

  let dataUri: string;
  if (asset.base64) {
    dataUri = `data:${asset.type || 'image/jpeg'};base64,${asset.base64}`;
  } else if (asset.uri) {
    const b64 = await RNFS.readFile(asset.uri, 'base64');
    dataUri = `data:${asset.type || 'image/jpeg'};base64,${b64}`;
  } else {
    return null;
  }

  const fileUri = await saveToTempFile(dataUri, 'img');
  return { uri: fileUri, dataUri, type: 'image' };
}

// === КОМПОНЕНТ ===================================================
export default function ChatScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [statusText, setStatusText] = useState('Отправка...');
  const [contactName, setContactName] = useState('');
  const [viewImage, setViewImage] = useState<string | null>(null);

  const connRef = useRef<HubConnection | null>(null);
  const myKeyRef = useRef('');
  const myNameRef = useRef('');
  const theirKeyRef = useRef('');
  const sharedKeyRef = useRef<Uint8Array | null>(null);
  const chunksRef = useRef<Map<string, string[]>>(new Map());
  const videoStreamsRef = useRef<Map<string, { chunks: (string | null)[]; total: number }>>(new Map());
  const flatListRef = useRef<FlatList>(null);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => {
      const next = [msg, ...prev];
      saveMessages(next);
      return next;
    });
  }, []);

  const handleIncoming = useCallback(async (plainText: string) => {
    const isImg = plainText.startsWith(IMAGE_DATA_PREFIX);
    const isVid = plainText.startsWith(VIDEO_DATA_PREFIX);

    let image: string | undefined;
    let video: string | undefined;

    if (isImg) {
      image = await saveToTempFile(plainText, 'rcv_img');
    } else if (isVid) {
      video = await saveToTempFile(plainText, 'rcv_vid');
    }

    addMessage({
      id: `in-${Date.now()}-${Math.random()}`,
      text: isImg || isVid ? '' : plainText,
      image,
      video,
      fromMe: false,
      timestamp: Date.now(),
    });
  }, [addMessage]);

  useEffect(() => {
    let dead = false;
    let conn: HubConnection | null = null;

    (async () => {
      const saved = loadMessages();
      if (saved.length > 0 && !dead) setMessages(saved);

      const ip = await AsyncStorage.getItem('server_ip');
      const username = await AsyncStorage.getItem('my_username');
      const tokenData = await Keychain.getGenericPassword({ service: 'e2e_auth_token' });
      const privData = await Keychain.getGenericPassword({ service: 'e2e_private_key' });

      if (!ip || !username || !tokenData || !privData) return;

      myNameRef.current = username;
      myKeyRef.current = privData.password;

      try {
        const res = await fetch(`${ip}/contact?myUsername=${encodeURIComponent(username)}`);
        if (res.ok) {
          const data = await res.json();
          theirKeyRef.current = data.publicKey;
          sharedKeyRef.current = getSharedKey(data.publicKey, privData.password);
          if (!dead) setContactName(data.username);
        }
      } catch {}

      // Добавляем username и token в URL для сервера (SignalR читает из Query)
      // accessTokenFactory добавляет access_token, дублируем его в URL для надёжности
      const hubUrl = `${ip}/chathub?username=${encodeURIComponent(username)}&access_token=${encodeURIComponent(tokenData.password)}`;
      conn = new HubConnectionBuilder()
        .withUrl(hubUrl, {
          // accessTokenFactory не нужен - уже в URL
          skipNegotiation: false,
          transport: 0, // На моём впс вебсокет не завелся, поэтому пошел он в пезду...! Тепер лонгхуёлинг тоже есть!
        })
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .build();

      conn.on('ReceiveMessage', async (_sender: string, raw: string) => {
        if (dead || !theirKeyRef.current) return;

        // Потоковое видео - каждый чанк зашифрован отдельно
        const vm = raw.match(/^__VSTM__(.+?)__(\d+)__(\d+)__/);
        if (vm) {
          const hdr = vm[0], streamId = vm[1], idx = +vm[2], tot = +vm[3];
          const encChunk = raw.slice(hdr.length);
          const buf = videoStreamsRef.current;
          if (!buf.has(streamId)) buf.set(streamId, { chunks: new Array(tot).fill(null), total: tot });
          buf.get(streamId)!.chunks[idx] = encChunk;
          if (buf.get(streamId)!.chunks.every(c => c !== null)) {
            const { chunks } = buf.get(streamId)!;
            buf.delete(streamId);
            const sk = sharedKeyRef.current;
            if (!sk) return;
            const path = `${RNFS.CachesDirectoryPath}/rcv_vid_${Date.now()}.mp4`;
            for (let i = 0; i < chunks.length; i++) {
              const dec = decryptChunk(chunks[i]!, sk);
              if (!dec) return;
              const b64 = Buffer.from(dec).toString('base64');
              if (i === 0) await RNFS.writeFile(path, b64, 'base64');
              else await RNFS.appendFile(path, b64, 'base64');
            }
            if (!dead) addMessage({ id: `in-${Date.now()}-${Math.random()}`, text: '', video: `file://${path}`, fromMe: false, timestamp: Date.now() });
          }
          return;
        }

        // Обычные чанки (текст или фото)
        const cm = raw.match(/^__CHUNK__(.+?)__(\d+)__(\d+)__/);
        if (cm) {
          const [hdr, msgId, idxS, totS] = cm;
          const idx = +idxS, tot = +totS;
          const data = raw.slice(hdr.length);
          const buf = chunksRef.current;
          if (!buf.has(msgId)) buf.set(msgId, Array(tot).fill(''));
          buf.get(msgId)![idx] = data;
          if (buf.get(msgId)!.every(c => c !== '')) {
            const full = buf.get(msgId)!.join('');
            buf.delete(msgId);
            const plain = decryptPayload(full, theirKeyRef.current, myKeyRef.current);
            if (plain) handleIncoming(plain);
          }
        } else {
          const plain = decryptPayload(raw, theirKeyRef.current, myKeyRef.current);
          if (plain) handleIncoming(plain);
        }
      });

      conn.onreconnecting(() => { if (!dead) setConnected(false); });
      conn.onreconnected(() => { if (!dead) setConnected(true); });
      conn.onclose(() => { if (!dead) setConnected(false); });

      try {
        await conn.start();
        if (dead) { conn.stop(); return; }
        connRef.current = conn;
        setConnected(true);
      } catch {}
    })();

    return () => { dead = true; conn?.stop().catch(() => {}); connRef.current = null; };
  }, [handleIncoming]);

  const handleSendText = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    setText('');

    addMessage({ id: `out-${Date.now()}`, text: t, fromMe: true, timestamp: Date.now() });

    const conn = connRef.current;
    if (!conn || conn.state !== HubConnectionState.Connected || !theirKeyRef.current) return;

    try {
      const enc = encryptPayload(t, theirKeyRef.current, myKeyRef.current);
      await sendChunked(conn, myNameRef.current, contactName, enc);
    } catch (e) {
      console.error('[Send] error:', e);
    }
  }, [text, contactName, addMessage]);

  const handleSendMedia = useCallback(async () => {
    try {
      setStatusText('Сжатие видео...');
      const media = await pickMedia(ratio => {
        setSending(true);
        setStatusText(`Сжатие видео... ${Math.round(ratio * 100)}%`);
      });
      if (!media) {
        setSending(false);
        return;
      }

      setSending(true);
      setStatusText('Отправка...');

      addMessage({
        id: `out-${Date.now()}-${Math.random()}`,
        text: '',
        image: media.type === 'image' ? media.uri : undefined,
        video: media.type === 'video' ? media.uri : undefined,
        fromMe: true,
        timestamp: Date.now(),
      });

      const conn = connRef.current;
      if (!conn || conn.state !== HubConnectionState.Connected || !theirKeyRef.current) {
        setSending(false);
        return;
      }

      if (media.type === 'video' && sharedKeyRef.current) {
        await sendVideoStream(
          conn, myNameRef.current, contactName, media.uri, sharedKeyRef.current,
          (sent, total) => setStatusText(`Отправка... ${Math.round((sent / total) * 100)}%`),
        );
      } else {
        const enc = encryptPayload(media.dataUri, theirKeyRef.current, myKeyRef.current);
        await sendChunked(conn, myNameRef.current, contactName, enc);
      }
      setSending(false);
    } catch (e) {
      console.error('[Media] error:', e);
      setSending(false);
      // Явная ошибка вместо тихого пиздеца: видео могло уйти частично
      Alert.alert('Не удалось отправить', 'Видео отправлено не полностью. Попробуйте ещё раз.');
    }
  }, [contactName, addMessage]);

  const handleLongPress = useCallback((msg: ChatMessage) => {
    const uri = msg.image || msg.video;
    if (!uri || !uri.startsWith('file://')) return;
    Alert.alert('Сохранить в галерею?', '', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Сохранить', onPress: () => saveToGallery(uri) },
    ]);
  }, []);

  const handleClear = useCallback(() => {
    Alert.alert('Удалить историю?', 'Все сообщения будут удалены', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => { setMessages([]); storage.delete(MESSAGES_KEY); } },
    ]);
  }, []);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<ChatMessage>) => {
    const isMe = item.fromMe;
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={() => handleLongPress(item)}
        style={[styles.msgRow, isMe ? styles.msgRowRight : styles.msgRowLeft]}
      >
        <View style={[styles.bubble, isMe ? styles.bubbleRight : styles.bubbleLeft]}>
          {item.image && (
            <TouchableOpacity onPress={() => setViewImage(item.image!)} activeOpacity={0.9}>
              <Image source={{ uri: item.image }} style={styles.msgImage} resizeMode="cover" />
            </TouchableOpacity>
          )}
          {item.video && (
            <View style={styles.videoWrap}>
              <Video
                source={{ uri: item.video }}
                style={styles.msgVideo}
                resizeMode="contain"
                controls
                paused
              />
            </View>
          )}
          {!!item.text && (
            <Text style={[styles.msgText, isMe ? styles.msgTextRight : styles.msgTextLeft]}>
              {item.text}
            </Text>
          )}
          <Text style={[styles.msgTime, isMe ? styles.msgTimeRight : styles.msgTimeLeft]}>
            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [handleLongPress]);

  const content = (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
          <Text style={styles.clearBtnText}>X</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {contactName || 'Ожидание...'}
        </Text>
        {connected
          ? <View style={styles.dotOnline} />
          : <ActivityIndicator size="small" color="#E91E63" />
        }
      </View>

      {sending && (
        <View style={styles.sendingBar}>
          <ActivityIndicator size="small" color="#E91E63" />
          <Text style={styles.sendingBarText}>{statusText}</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        inverted
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      />

      <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TouchableOpacity onPress={handleSendMedia} style={styles.attachBtn}>
          <Text style={styles.attachBtnText}>+</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Сообщение..."
          placeholderTextColor="#999"
          multiline
          maxLength={5000}
        />
        <TouchableOpacity onPress={handleSendText} style={styles.sendBtn}>
          <Text style={styles.sendBtnText}>E2E</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={!!viewImage} transparent animationType="fade" onRequestClose={() => setViewImage(null)}>
        <View style={styles.viewerBg}>
          <ScrollView contentContainerStyle={styles.viewerContent} horizontal={false}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              {viewImage && <Image source={{ uri: viewImage }} style={styles.viewerImage} resizeMode="contain" />}
            </ScrollView>
          </ScrollView>
          <Pressable style={styles.viewerClose} onPress={() => setViewImage(null)}>
            <Text style={styles.viewerCloseText}>✕</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      {content}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF9FA' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F8BBD0',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#212121',
    textAlign: 'center',
  },
  clearBtn: {
    backgroundColor: '#FCE4EC',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  clearBtnText: { fontSize: 12, fontWeight: '700', color: '#E91E63' },
  dotOnline: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4CAF50',
    marginLeft: 8,
  },
  sendingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    backgroundColor: '#FCE4EC',
  },
  sendingBarText: { marginLeft: 8, fontSize: 12, color: '#E91E63' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12, paddingVertical: 8 },
  msgRow: { marginVertical: 3 },
  msgRowRight: { alignItems: 'flex-end' },
  msgRowLeft: { alignItems: 'flex-start' },
  bubble: {
    maxWidth: '78%',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleRight: { backgroundColor: '#EC407A', borderBottomRightRadius: 4 },
  bubbleLeft: { backgroundColor: '#FCE4EC', borderBottomLeftRadius: 4 },
  msgText: { fontSize: 16, lineHeight: 22 },
  msgTextRight: { color: '#FFF' },
  msgTextLeft: { color: '#212121' },
  msgTime: { fontSize: 11, marginTop: 4 },
  msgTimeRight: { color: 'rgba(255,255,255,0.7)', textAlign: 'right' },
  msgTimeLeft: { color: '#999', textAlign: 'left' },
  msgImage: { width: 260, height: 260, borderRadius: 12, marginBottom: 4 },
  videoWrap: {
    width: 220,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 4,
  },
  msgVideo: { width: '100%', height: '100%' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 8,
    backgroundColor: '#FFF',
    borderTopWidth: 1,
    borderTopColor: '#F8BBD0',
  },
  attachBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FCE4EC',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 2,
  },
  attachBtnText: { fontSize: 22, color: '#E91E63', fontWeight: '300', marginTop: -2 },
  input: {
    flex: 1,
    fontSize: 16,
    color: '#212121',
    maxHeight: 120,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#FFF9FA',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#F8BBD0',
  },
  sendBtn: {
    backgroundColor: '#E91E63',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginLeft: 8,
    marginBottom: 2,
  },
  sendBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  viewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  viewerContent: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  viewerImage: { width: '100%', height: '80%' },
  viewerClose: { position: 'absolute', top: 50, right: 20, zIndex: 10, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  viewerCloseText: { color: '#FFF', fontSize: 20, fontWeight: 'bold' },
});