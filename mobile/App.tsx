import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PatientScreen } from './src/screens/patient/PatientScreen';
import { PortalScreen } from './src/screens/portal/PortalScreen';

/** Web = researcher portal; native = patient app. On web, add ?patient to preview the patient app. */
export function selectExperience(os: string, search: string | undefined): 'portal' | 'patient' {
  if (os !== 'web') return 'patient';
  return search && /[?&]patient\b/.test(search) ? 'patient' : 'portal';
}

export default function App() {
  const search = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : undefined;
  const experience = selectExperience(Platform.OS, search);
  return (
    <SafeAreaProvider>
      {experience === 'portal' ? <PortalScreen /> : <PatientScreen />}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
