/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'fs';
import path from 'path';
import pico from 'picocolors';
import {Config, IOSProjectConfig} from '@react-native-community/cli-types';
import {
  logger,
  CLIError,
  link,
  startServerInNewWindow,
  findDevServerPort,
  cacheManager,
} from '@react-native-community/cli-tools';
import getArchitecture from '../../tools/getArchitecture';
import listDevices from '../../tools/listDevices';
import {promptForDeviceSelection} from '../../tools/prompts';
import {BuildFlags} from '../buildCommand/buildOptions';
import {buildProject} from '../buildCommand/buildProject';
import {getConfiguration} from '../buildCommand/getConfiguration';
import {getXcodeProjectAndDir} from '../buildCommand/getXcodeProjectAndDir';
import {getFallbackSimulator} from './getFallbackSimulator';
import {getPlatformInfo} from './getPlatformInfo';
import {printFoundDevices, matchingDevice} from './matchingDevice';
import {runOnDevice} from './runOnDevice';
import {runOnSimulator} from './runOnSimulator';
import {BuilderCommand} from '../../types';
import {
  supportedPlatforms,
  resolvePods,
} from '@react-native-community/cli-config-apple';
import openApp from './openApp';

export interface FlagsT extends BuildFlags {
  simulator?: string;
  device?: string | true;
  udid?: string;
  binaryPath?: string;
  listDevices?: boolean;
  packager?: boolean;
  port: number;
  terminal?: string;
}

function getPackageJson(root: string) {
  try {
    return require(path.join(root, 'package.json'));
  } catch {
    throw new CLIError(
      'No package.json found. Please make sure the file exists in the current folder.',
    );
  }
}

const createRun =
  ({platformName}: BuilderCommand) =>
  async (_: Array<string>, ctx: Config, args: FlagsT) => {
    // React Native docs assume platform is always ios/android
    link.setPlatform('ios');
    const platformConfig = ctx.project[platformName] as IOSProjectConfig;
    const {sdkNames, readableName: platformReadableName} =
      getPlatformInfo(platformName);

    if (
      platformConfig === undefined ||
      supportedPlatforms[platformName] === undefined
    ) {
      throw new CLIError(
        `Unable to find ${platformReadableName} platform config`,
      );
    }

    let {packager, port} = args;
    let installedPods = false;
    // check if pods need to be installed
    if (
      platformConfig.automaticPodsInstallation ||
      args.forcePods ||
      args.onlyPods
    ) {
      const isAppRunningNewArchitecture = platformConfig.sourceDir
        ? await getArchitecture(platformConfig.sourceDir)
        : undefined;

      await resolvePods(
        ctx.root,
        platformConfig.sourceDir,
        ctx.dependencies,
        platformName,
        ctx.reactNativePath,
        {
          forceInstall: args.forcePods || args.onlyPods,
          newArchEnabled: isAppRunningNewArchitecture,
        },
      );

      installedPods = true;
    }

    if (args.onlyPods) {
      return;
    }

    if (packager) {
      const {port: newPort, startPackager} = await findDevServerPort(
        port,
        ctx.root,
      );

      if (startPackager) {
        await startServerInNewWindow(
          newPort,
          ctx.root,
          ctx.reactNativePath,
          args.terminal,
        );
      }
    }

    if (ctx.reactNativeVersion !== 'unknown') {
      link.setVersion(ctx.reactNativeVersion);
    }

    let {xcodeProject, sourceDir} = getXcodeProjectAndDir(
      platformConfig,
      platformName,
      installedPods,
    );

    process.chdir(sourceDir);

    if (args.binaryPath) {
      args.binaryPath = path.isAbsolute(args.binaryPath)
        ? args.binaryPath
        : path.join(ctx.root, args.binaryPath);

      if (!fs.existsSync(args.binaryPath)) {
        throw new CLIError(
          'binary-path was specified, but the file was not found.',
        );
      }
    }

    const {mode, scheme} = await getConfiguration(
      xcodeProject,
      sourceDir,
      args,
      platformName,
    );

    if (platformName === 'macos') {
      const buildOutput = await buildProject(
        xcodeProject,
        platformName,
        undefined,
        mode,
        scheme,
        args,
      );

      openApp({
        buildOutput,
        xcodeProject,
        mode,
        scheme,
        target: args.target,
        binaryPath: args.binaryPath,
      });

      return;
    }

    let devices = await listDevices(sdkNames);

    if (devices.length === 0) {
      return logger.error(
        `${platformReadableName} devices or simulators not detected. Install simulators via Xcode or connect a physical ${platformReadableName} device`,
      );
    }

    const packageJson = getPackageJson(ctx.root);

    const preferredDevice = cacheManager.get(
      packageJson.name,
      'lastUsedIOSDeviceId',
    );

    if (preferredDevice) {
      const preferredDeviceIndex = devices.findIndex(
        ({udid}) => udid === preferredDevice,
      );

      if (preferredDeviceIndex > -1) {
        const [device] = devices.splice(preferredDeviceIndex, 1);
        devices.unshift(device);
      }
    }

    const fallbackSimulator =
      platformName === 'ios' || platformName === 'tvos'
        ? getFallbackSimulator(args)
        : devices[0];

    if (args.listDevices || args.interactive) {
      if (args.device || args.udid) {
        logger.warn(
          `Both ${
            args.device ? 'device' : 'udid'
          } and "list-devices" parameters were passed to "run" command. We will list available devices and let you choose from one.`,
        );
      }

      const selectedDevice = await promptForDeviceSelection(devices);

      if (!selectedDevice) {
        throw new CLIError(
          `Failed to select device, please try to run app without ${
            args.listDevices ? 'list-devices' : 'interactive'
          } command.`,
        );
      } else {
        if (selectedDevice.udid !== preferredDevice) {
          cacheManager.set(
            packageJson.name,
            'lastUsedIOSDeviceId',
            selectedDevice.udid,
          );
        }
      }

      if (selectedDevice.type === 'simulator') {
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          selectedDevice,
        );
      } else {
        return runOnDevice(
          selectedDevice,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    }

    if (!args.device && !args.udid && !args.simulator) {
      const bootedSimulators = devices.filter(
        ({state, type}) => state === 'Booted' && type === 'simulator',
      );
      const bootedDevices = devices.filter(({type}) => type === 'device'); // Physical devices here are always booted
      const booted = [...bootedSimulators, ...bootedDevices];

      if (booted.length === 0) {
        logger.info(
          'No booted devices or simulators found. Launching first available simulator...',
        );
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          fallbackSimulator,
        );
      }

      logger.info(`Found booted ${booted.map(({name}) => name).join(', ')}`);

      for (const simulator of bootedSimulators) {
        await runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          simulator || fallbackSimulator,
        );
      }

      for (const device of bootedDevices) {
        await runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }

      return;
    }

    if (args.device && args.udid) {
      return logger.error(
        'The `device` and `udid` options are mutually exclusive.',
      );
    }

    if (args.udid) {
      const device = devices.find((d) => d.udid === args.udid);
      if (!device) {
        return logger.error(
          `Could not find a device with udid: "${pico.bold(
            args.udid,
          )}". ${printFoundDevices(devices)}`,
        );
      }
      if (device.type === 'simulator') {
        return runOnSimulator(
          xcodeProject,
          platformName,
          mode,
          scheme,
          args,
          fallbackSimulator,
        );
      } else {
        return runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    } else if (args.device) {
      let device = matchingDevice(devices, args.device);

      if (!device) {
        const deviceByUdid = devices.find((d) => d.udid === args.device);
        if (!deviceByUdid) {
          return logger.error(
            `Could not find a physical device with name or unique device identifier: "${pico.bold(
              typeof args.device === 'string' ? args.device : 'true',
            )}". ${printFoundDevices(devices, 'device')}`,
          );
        }

        device = deviceByUdid;

        if (deviceByUdid.type === 'simulator') {
          return logger.error(
            `The device with udid: "${pico.bold(
              typeof args.device === 'string' ? args.device : 'true',
            )}" is a simulator. If you want to run on a simulator, use the "--simulator" flag instead.`,
          );
        }
      }

      if (device && device.type === 'simulator') {
        return logger.error(
          "`--device` flag is intended for physical devices. If you're trying to run on a simulator, use `--simulator` instead.",
        );
      }

      if (device && device.type === 'device') {
        return runOnDevice(
          device,
          platformName,
          mode,
          scheme,
          xcodeProject,
          args,
        );
      }
    } else {
      runOnSimulator(
        xcodeProject,
        platformName,
        mode,
        scheme,
        args,
        fallbackSimulator,
      );
    }
  };

export default createRun;
