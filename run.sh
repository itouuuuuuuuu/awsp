#!/bin/sh

# AWS Profile Switcher with MFA support
# AWS_PROFILE="$AWS_PROFILE" _awsp_prompt
AWS_PROFILE="$AWS_PROFILE"

# Configuration
AWS_REGION="ap-northeast-1"
CREDENTIALS_TEMP_FILE="$HOME/.awsp-credentials"

# Check dependencies
check_dependencies() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed. Please install jq." >&2
    exit 1
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "Error: AWS CLI is required but not installed. Please install AWS CLI." >&2
    exit 1
  fi
}

# Assume role with MFA authentication
assume_role_with_mfa() {
  local profile=$1
  local mfa_code=$2
  
  # Get required configuration from AWS config
  local role_arn=$(aws configure get $profile.role_arn 2>/dev/null)
  local mfa_serial=$(aws configure get $profile.mfa_serial 2>/dev/null)
  
  if [ -z "$role_arn" ] || [ -z "$mfa_serial" ]; then
    echo "Error: role_arn or mfa_serial not configured for profile $profile" >&2
    return 1
  fi
  
  # Execute STS AssumeRole
  AWS_STS_CREDENTIALS=$(aws sts assume-role \
    --profile default \
    --role-arn "$role_arn" \
    --role-session-name "$profile-session" \
    --serial-number "$mfa_serial" \
    --token-code "$mfa_code" 2>/dev/null)
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to assume role. Check your MFA code and try again." >&2
    return 1
  fi
  
  # Extract credentials from response
  AWS_ACCESS_KEY_ID=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.AccessKeyId')
  AWS_SECRET_ACCESS_KEY=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SecretAccessKey')
  AWS_SESSION_TOKEN=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SessionToken')
  
  # Copy credentials to clipboard
  clipboard_content="AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
  
  echo "$clipboard_content" | pbcopy 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "Credentials copied to clipboard"
  else
    echo "Successfully assumed role (clipboard copy failed)"
  fi
  
  # Output environment variables for eval
  echo "export AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID"
  echo "export AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
  echo "export AWS_REGION=$AWS_REGION"
  echo "export AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
  echo "export AWS_PROFILE=$profile"
  echo "export AWS_DEFAULT_PROFILE=$profile"
}

# Process credentials from temporary file
process_credentials_file() {
  local credentials_file="$CREDENTIALS_TEMP_FILE"
  local silent_mode="$1"
  
  if [ -f "$credentials_file" ]; then
    if [ "$silent_mode" = "silent" ]; then
      # Silent mode: Load environment variables from temp file
      # (Message and clipboard copy already handled by index.js)
      eval "$(cat "$credentials_file")"
    else
      # Normal mode: Output environment variables for eval
      cat "$credentials_file"
    fi
    rm -f "$credentials_file"
  fi
}

# Check dependencies before proceeding
check_dependencies

# Parse command line options
mfa_code=""
while getopts "m:" opt; do
  case $opt in
    m)
      mfa_code="$OPTARG"
      ;;
    \?)
      echo "Usage: $0 [-m MFA_CODE] [PROFILE_NAME]" >&2
      exit 1
      ;;
  esac
done

shift $((OPTIND-1))

# Handle command line profile argument
if [ $# -ge 1 ]; then
  profile="$1"
  
  if [ -n "$mfa_code" ]; then
    # MFA code provided: execute AssumeRole directly
    assume_role_with_mfa "$profile" "$mfa_code"
  else
    # No MFA code: set profile conventionally
    export AWS_PROFILE="$profile"
    export AWS_DEFAULT_PROFILE="$profile"
    echo "set profile: $AWS_PROFILE"
  fi
else
  # Interactive mode: run Node.js selector
  CURRENT=$(cd $(dirname $0);pwd)
  "$CURRENT/index.js"

  selected_profile="$(cat ~/.awsp 2>/dev/null)"
  
  if [ -z "$selected_profile" ]; then
    unset AWS_PROFILE
    unset AWS_DEFAULT_PROFILE
  else
    # Check if credentials file exists (MFA processing was done)
    if [ -f "$CREDENTIALS_TEMP_FILE" ]; then
      # MFA processed: load credentials silently (no echo)
      process_credentials_file "silent"
    else
      # No MFA processing: set profile conventionally
      export AWS_PROFILE="$selected_profile"
      export AWS_DEFAULT_PROFILE="$selected_profile"
      echo "set profile: $AWS_PROFILE"
    fi
  fi
fi