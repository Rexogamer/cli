import pico from 'picocolors';
import versionRanges from '../versionRanges';
import {doesSoftwareNeedToBeFixed} from '../checkInstallation';
import {EnvironmentInfo, HealthCheckInterface} from '../../types';

export default {
  label: 'Android NDK',
  description: 'Required for building React Native from the source',
  getDiagnostics: async ({SDKs}: EnvironmentInfo) => {
    const androidSdk = SDKs['Android SDK'];
    const version =
      androidSdk === 'Not Found' ? androidSdk : androidSdk['Android NDK'];

    return {
      needsToBeFixed: doesSoftwareNeedToBeFixed({
        version,
        versionRange: versionRanges.ANDROID_NDK,
      }),
      version,
      versionRange: versionRanges.ANDROID_NDK,
    };
  },
  runAutomaticFix: async ({loader, logManualInstallation, environmentInfo}) => {
    const androidSdk = environmentInfo.SDKs['Android SDK'];
    const isNDKInstalled =
      androidSdk !== 'Not Found' && androidSdk['Android NDK'] !== 'Not Found';

    loader.fail();

    if (isNDKInstalled) {
      return logManualInstallation({
        message: `Read more about how to update Android NDK at ${pico.dim(
          'https://developer.android.com/ndk/downloads',
        )}`,
      });
    }

    return logManualInstallation({
      healthcheck: 'Android NDK',
      url: 'https://developer.android.com/ndk/downloads',
    });
  },
} as HealthCheckInterface;
