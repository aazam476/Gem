import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GemRoot } from './src/screens/assistant/GemRoot';
import { PortalScreen } from './src/screens/portal/PortalScreen';

/** Web = researcher portal; native = Gem assistant. On web, add ?patient to preview the assistant. */
export function selectExperience(os: string, search: string | undefined): 'portal' | 'patient' {
  if (os !== 'web') return 'patient';
  return search && /[?&]patient\b/.test(search) ? 'patient' : 'portal';
}

export default function App() {
  const search = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : undefined;
  const experience = selectExperience(Platform.OS, search);
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {/* Follows light/dark mode; the camera screen overrides it with its own light bar. */}
        <StatusBar style="auto" />
        {experience === 'portal' ? <PortalScreen /> : <GemRoot />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
