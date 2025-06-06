/**
 * Android platform files
 */

export {default as commands} from './commands';
export {
  adb,
  getAdbPath,
  listAndroidDevices,
  tryRunAdbReverse,
} from './commands/runAndroid';
export {
  projectConfig,
  dependencyConfig,
  getAndroidProject,
  getPackageName,
  isProjectUsingKotlin,
} from '@react-native-community/cli-config-android';
