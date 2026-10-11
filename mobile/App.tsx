import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
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
    <SafeAreaProvider>
      {experience === 'portal' ? <PortalScreen /> : <GemRoot />}
      <StatusBar style={experience === 'portal' ? 'auto' : 'light'} />
    </SafeAreaProvider>
  );
}
