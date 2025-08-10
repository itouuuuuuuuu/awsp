#!/usr/bin/env node

/**
 * AWS Profile Switcher with MFA Support
 * Interactive profile selector with automatic AssumeRole functionality
 */

const fs = require('fs');
const inquirer = require('inquirer');
const { execSync } = require('child_process');

console.log('AWS Profile Switcher');

// Configuration constants
const CONFIG = {
  homeDir: process.env['HOME'],
  awsRegion: 'ap-northeast-1',
  credentialsFile: `${process.env['HOME']}/.awsp-credentials`,
  profileFile: `${process.env['HOME']}/.awsp`,
  awsConfigFile: `${process.env['HOME']}/.aws/config`
};

const REGEX = {
  profile: /\[profile .*]/g,
  bracketsRemoval: /(\[profile )|(\])/g
};

const DEFAULTS = {
  profile: 'default',
  mfaCodeLength: 6
};

/**
 * Display profile selection prompt
 * @param {string} data - AWS config file content
 * @returns {Promise} Profile selection promise
 */
const promptProfileChoice = (data) => {
  const matches = data.match(REGEX.profile);

  if (!matches) {
    console.log('No profiles found.');
    console.log('Refer to this guide for help on setting up a new AWS profile:');
    console.log('https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html');
    return;
  }

  const profiles = matches.map((match) => {
    return match.replace(REGEX.bracketsRemoval, '');
  });

  profiles.push(DEFAULTS.profile);

  const profileChoice = [
    {
      type: 'list',
      name: 'profile',
      message: 'Choose a profile',
      choices: profiles,
      default: process.env.AWS_DEFAULT_PROFILE || process.env.AWS_PROFILE || DEFAULTS.profile
    }
  ];

  return inquirer.prompt(profileChoice);
};

/**
 * Read AWS configuration file
 * @returns {Promise<string>} Promise resolving to config file content
 */
const readAwsProfiles = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(CONFIG.awsConfigFile, 'utf8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
};

/**
 * Write selected profile to configuration file
 * @param {Object} answers - User selection answers
 * @returns {Promise<string>} Promise resolving to selected profile name
 */
const writeToConfig = (answers) => {
  const profileChoice = answers.profile;

  return new Promise((resolve, reject) => {
    fs.writeFile(CONFIG.profileFile, profileChoice, { flag: 'w' }, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(profileChoice);
      }
    });
  });
};

/**
 * Prompt for MFA code input
 * @returns {Promise<Object>} Promise resolving to MFA code input
 */
const promptMfaCode = () => {
  const mfaQuestion = [
    {
      type: 'input',
      name: 'mfaCode',
      message: 'Enter MFA code:',
      validate: function(value) {
        if (!value || value.length !== DEFAULTS.mfaCodeLength || !/^\d+$/.test(value)) {
          return `Please enter a valid ${DEFAULTS.mfaCodeLength}-digit MFA code`;
        }
        return true;
      }
    }
  ];

  return inquirer.prompt(mfaQuestion);
};

/**
 * Check if profile has role configuration for AssumeRole
 * @param {string} profile - AWS profile name
 * @returns {boolean} True if profile has role_arn and mfa_serial configured
 */
const hasRoleConfiguration = (profile) => {
  try {
    const roleArn = execSync(`aws configure get ${profile}.role_arn`, { encoding: 'utf8' }).trim();
    const mfaSerial = execSync(`aws configure get ${profile}.mfa_serial`, { encoding: 'utf8' }).trim();
    return roleArn && mfaSerial;
  } catch (error) {
    return false;
  }
};

/**
 * Get AWS configuration value for a profile
 * @param {string} profile - Profile name
 * @param {string} key - Configuration key
 * @returns {string} Configuration value
 */
const getAwsConfig = (profile, key) => {
  return execSync(`aws configure get ${profile}.${key}`, { encoding: 'utf8' }).trim();
};

/**
 * Copy credentials to clipboard
 * @param {Object} credentials - AWS credentials
 * @returns {boolean} Success status
 */
const copyToClipboard = (credentials) => {
  const clipboardContent = `AWS_ACCESS_KEY_ID=${credentials.accessKeyId}
AWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}
AWS_REGION=${CONFIG.awsRegion}
AWS_SESSION_TOKEN=${credentials.sessionToken}`;
  
  try {
    execSync(`echo "${clipboardContent}" | pbcopy`);
    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Perform AWS STS AssumeRole with MFA
 * @param {string} profile - AWS profile name
 * @param {string} mfaCode - MFA authentication code
 * @returns {boolean} Success status
 */
const performAssumeRole = (profile, mfaCode) => {
  try {
    // Get role configuration
    const roleArn = getAwsConfig(profile, 'role_arn');
    const mfaSerial = getAwsConfig(profile, 'mfa_serial');
    
    // Execute AssumeRole
    const assumeRoleCommand = `aws sts assume-role --profile default --role-arn "${roleArn}" --role-session-name "${profile}-session" --serial-number "${mfaSerial}" --token-code "${mfaCode}"`;
    const stsCredentials = execSync(assumeRoleCommand, { encoding: 'utf8' });
    const credentials = JSON.parse(stsCredentials);
    
    // Extract credentials
    const creds = {
      accessKeyId: credentials.Credentials.AccessKeyId,
      secretAccessKey: credentials.Credentials.SecretAccessKey,
      sessionToken: credentials.Credentials.SessionToken
    };
    
    // Create credentials content for shell export
    const credentialsContent = `export AWS_ACCESS_KEY_ID=${creds.accessKeyId}
export AWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}
export AWS_REGION=${CONFIG.awsRegion}
export AWS_SESSION_TOKEN=${creds.sessionToken}
export AWS_PROFILE=${profile}
export AWS_DEFAULT_PROFILE=${profile}`;
    
    // Write to temporary file for shell processing
    fs.writeFileSync(CONFIG.credentialsFile, credentialsContent);
    
    // Copy to clipboard and display result
    const clipboardSuccess = copyToClipboard(creds);
    const message = clipboardSuccess 
      ? `Successfully assumed role for profile: ${profile}`
      : `Successfully assumed role for profile: ${profile} (clipboard copy failed)`;
    
    console.log(message);
    return true;
    
  } catch (error) {
    console.error('Error assuming role:', error.message);
    return false;
  }
};

/**
 * Main application flow
 */
const main = async () => {
  try {
    // Read AWS profiles and prompt for selection
    const awsConfig = await readAwsProfiles();
    const profileAnswer = await promptProfileChoice(awsConfig);
    
    if (!profileAnswer) {
      return; // No profiles found
    }
    
    // Write selected profile to config
    const profileChoice = await writeToConfig(profileAnswer);
    
    // Check if profile requires MFA authentication
    if (hasRoleConfiguration(profileChoice)) {
      try {
        const mfaAnswer = await promptMfaCode();
        const success = performAssumeRole(profileChoice, mfaAnswer.mfaCode);
        
        if (!success) {
          process.exit(1);
        }
      } catch (error) {
        console.error('MFA authentication failed:', error.message);
        process.exit(1);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
  }
};

// Run the application
main();