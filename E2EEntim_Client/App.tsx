// App.tsx
import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, LogBox } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';

import StartupScreen from './src/screens/StartupScreen';
import ChatScreen from './src/screens/ChatScreen';
import 'react-native-get-random-values';
// Импортируем нашу функцию инициализации
import { initSecureStorage } from './src/uti/storage'; 

LogBox.ignoreLogs([
  'A props object containing a "key" prop is being spread into JSX',
  'Non-serializable values were found in the navigation state',
]);

export type RootStackParamList = {
    Startup: undefined;
    Chat: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
    const [isChecking, setIsChecking] = useState(true);
    const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList>('Startup');

    useEffect(() => {
        const checkConfiguration = async () => {
            try {
                // 1. Инициализируем базу данных ДО рендера других экранов!
                await initSecureStorage();
              
                // 2. Проверяем авторизацию
                const isConfigured = await AsyncStorage.getItem('configured');
                if (isConfigured === '1') {
                    setInitialRoute('Chat');
                }
            } catch (error) {
                console.error("Ошибка при инициализации:", error);
            } finally {
                // 3. Выключаем экран загрузки
                setIsChecking(false);
            }
        };

        checkConfiguration();
    }, []);

    if (isChecking) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#6200ee" />
            </View>
        );
    }

    return (
        <NavigationContainer>
            <Stack.Navigator initialRouteName={initialRoute}>
                <Stack.Screen 
                    name="Startup" 
                    component={StartupScreen} 
                    options={{ headerShown: false }} 
                />
                <Stack.Screen 
                    name="Chat" 
                    component={ChatScreen}
                    options={{ headerBackVisible: false, headerShown: false }} 
                />
            </Stack.Navigator>
        </NavigationContainer>
    );
}