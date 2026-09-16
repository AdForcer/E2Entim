import React, { useState, useEffect } from 'react';
import { View, Alert } from 'react-native';
import { Button, TextInput } from 'react-native-paper';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';

export default function StartupScreen() {

    const navigation = useNavigation<any>();

    const [serverIp, setServerIp] = useState('');
    const [username, setUsername] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const checkExistingSession = async () => {
            // Читаем по ключу 'configured'
            const isConfigured = await AsyncStorage.getItem('configured');
            if (isConfigured === '1') {
                navigation.replace('Chat'); 
            }
        };
        checkExistingSession();
    }, [navigation]);

    const handleStart = async () => {
    if (!serverIp || !username) {
        Alert.alert("Ошибка", "Заполните все поля");
        return;
    }

    setLoading(true);
    try {
        // Криптография (tweetnacl)
        const keyPair = nacl.box.keyPair();
        const pubKeyString = encodeBase64(keyPair.publicKey);
        const secKeyString = encodeBase64(keyPair.secretKey);

        let formattedUrl = serverIp.trim().toLowerCase();

        if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
            formattedUrl = `http://${formattedUrl}`; //http вместо https
        }

        if (formattedUrl.endsWith('/')) {
            formattedUrl = formattedUrl.slice(0, -1);
        }

        console.log(`Попытка подключения к: ${formattedUrl}/register`);

        // Запрос на регистрацию к ASP.NET серверу
        const response = await fetch(`${formattedUrl}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                username: username,
                publicKey: pubKeyString
            })
        });

        if (response.status === 403) {
            Alert.alert("Отказ", "Превышен лимит участников (макс. 2)");
            setLoading(false);
            return;
        }

        if (!response.ok) {
            const errText = await response.text();
            Alert.alert("Ошибка сервера", errText || "Не удалось зарегистрироваться");
            setLoading(false);
            return;
        }

        const data = await response.json();
        const serverToken = data.token;

        // Токен и приватный ключ в Keychain
        await Keychain.setGenericPassword('e2e_user', secKeyString, { service: 'e2e_private_key' });
        await Keychain.setGenericPassword('e2e_user', serverToken, { service: 'e2e_auth_token' });

        // Сохранение открытых данных
        await AsyncStorage.setItem('e2e_public_key', pubKeyString);
        await AsyncStorage.setItem('server_ip', formattedUrl); // Сохраняем уже готовый красивый URL
        await AsyncStorage.setItem('my_username', username);
        await AsyncStorage.setItem('configured', "1");
        Alert.alert("Успех", "Токен получен, конфигурация сохранена!");
        
        navigation.replace('Chat');

    } catch (error: any) {
        console.error(error);
        Alert.alert("Ошибка подключения", "Не удалось связаться с сервером. Проверьте домен/IP и порт.");
    } finally {
        setLoading(false);
    }
}
    return (
        <View style={{ flex: 1, padding: 20, justifyContent: 'center' }}>
            <TextInput 
                label="Имя пользователя" 
                value={username} 
                onChangeText={setUsername} 
                mode="outlined" 
                style={{ marginBottom: 10 }}
            />
            <TextInput 
                label="Адрес сервера (IP:Порт)" 
                value={serverIp} 
                onChangeText={setServerIp} 
                mode="outlined" 
                style={{ marginBottom: 20 }}
                placeholder="10.0.2.2:5000"
            />
            <Button 
                mode="contained" 
                onPress={handleStart} 
                loading={loading}
                disabled={loading}
            >
                Войти
            </Button>
        </View>
    );
}