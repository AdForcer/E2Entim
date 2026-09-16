import { MMKV } from 'react-native-mmkv';
import * as Keychain from 'react-native-keychain';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// Экспортируем инстанс, изначально null
export let storage: MMKV | null = null;

export async function initSecureStorage() {
    if (storage) return;

    const SERVICE_NAME = 'mmkv_db_encryption_key';
    const credentials = await Keychain.getGenericPassword({ service: SERVICE_NAME });

    let secretKey = '';

    if (credentials) {
        secretKey = credentials.password;
    } else {
        const randomBytes = nacl.randomBytes(32);
        secretKey = encodeBase64(randomBytes);
        await Keychain.setGenericPassword('mmkv_user', secretKey, { service: SERVICE_NAME });
    }

    storage = new MMKV({
        id: 'e2ee-chat-v2',
        encryptionKey: secretKey,
    });
}