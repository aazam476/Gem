import { usePermissions } from '../../hooks/usePermissions';
import { AssistantScreen } from './AssistantScreen';
import { PermissionScreen } from './PermissionScreen';

/** Native entry: permissions gate, then the assistant. */
export function GemRoot() {
  const permissions = usePermissions();
  return permissions.status === 'granted' ? <AssistantScreen /> : <PermissionScreen permissions={permissions} />;
}
