import execa from 'execa';
import {CLIError, logger, link} from '@react-native-community/cli-tools';
import type {Ora} from 'ora';

async function runBundleInstall(loader: Ora) {
  try {
    loader.start('Installing Ruby Gems');

    await execa('bundle', ['install']);
  } catch (error) {
    loader.fail();
    logger.error((error as any).stderr || (error as any).stdout);
    throw new CLIError(
      `Looks like your iOS environment is not properly set. Please go to ${link.docs(
        'set-up-your-environment',
        'ios',
        {guide: 'native'},
      )} and follow the React Native CLI QuickStart guide for macOS and iOS.`,
    );
  }

  loader.succeed();
}

export default runBundleInstall;
