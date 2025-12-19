import crypto from 'crypto';
import axios from 'axios';
import { twilio } from '../lib/twilio.js';
import { env } from '../config/env.js';
import { log } from '../config/logger.js';

/**
 * Twilio Service for managing sub-accounts and phone numbers
 */

/**
 * Create a Twilio sub-account for an agent
 * @param {string} agentName - Name of the agent (used for friendly name)
 * @param {string} ownerId - Owner/business ID
 * @returns {Promise<{sid: string, authToken: string, friendlyName: string}>}
 */
export async function createTwilioSubAccount(agentName, ownerId) {
  try {
    // Validate Twilio credentials are present
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN) are not configured in environment variables');
    }

    log.info(`Creating Twilio sub-account for agent: ${agentName}`);
    log.debug(`Using Twilio Account SID: ${env.TWILIO_ACCOUNT_SID.substring(0, 8)}...`);
    
    const subAccount = await twilio.api.accounts.create({
      friendlyName: `Agent: ${agentName} (${ownerId.substring(0, 8)})`
    });

    log.info(`Twilio sub-account created: ${subAccount.sid}`);
    
    return {
      sid: subAccount.sid,
      authToken: subAccount.authToken,
      friendlyName: subAccount.friendlyName
    };
  } catch (error) {
    log.error('Error creating Twilio sub-account:', error);
    
    // Provide more specific error messages
    if (error.status === 401 || error.code === 20003) {
      const hasSid = !!env.TWILIO_ACCOUNT_SID;
      const hasToken = !!env.TWILIO_AUTH_TOKEN;
      
      let errorMsg = 'Twilio authentication failed (Error 401). ';
      if (!hasSid && !hasToken) {
        errorMsg += 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are missing from environment variables.';
      } else if (!hasSid) {
        errorMsg += 'TWILIO_ACCOUNT_SID is missing from environment variables.';
      } else if (!hasToken) {
        errorMsg += 'TWILIO_AUTH_TOKEN is missing from environment variables.';
      } else {
        errorMsg += 'The provided TWILIO_ACCOUNT_SID and/or TWILIO_AUTH_TOKEN are incorrect. Please verify your credentials in the Twilio Console.';
      }
      
      throw new Error(errorMsg);
    } else if (error.status === 403) {
      throw new Error(`Twilio account does not have permission to create sub-accounts. Your account type may not support sub-account creation. Please check your Twilio account settings.`);
    }
    
    throw new Error(`Failed to create Twilio sub-account: ${error.message}`);
  }
}

/**
 * Purchase a phone number for a Twilio sub-account
 * @param {string} subAccountSid - Sub-account SID
 * @param {string} subAccountAuthToken - Sub-account auth token
 * @param {object} options - Phone number search options
 * @param {string} options.countryCode - Country code (default: 'BR' for Brazil)
 * @param {string} options.areaCode - Area code for the phone number
 * @param {boolean} options.voiceEnabled - Voice capability (default: true)
 * @param {boolean} options.smsEnabled - SMS capability (default: true)
 * @returns {Promise<{phoneNumber: string, sid: string, friendlyName: string}>}
 */
export async function purchasePhoneNumber(subAccountSid, subAccountAuthToken, options = {}) {
  try {
    const {
      countryCode = 'BR',
      areaCode = null,
      voiceEnabled = true,
      smsEnabled = true
    } = options;

    log.info(`Searching for available phone numbers in ${countryCode}${areaCode ? ` (area code: ${areaCode})` : ''}`);

    // Create client for sub-account
    const Twilio = (await import('twilio')).default;
    const subAccountClient = Twilio(subAccountSid, subAccountAuthToken);

    // Search for available phone numbers
    const searchParams = {
      voiceEnabled,
      smsEnabled
    };

    if (areaCode) {
      searchParams.areaCode = areaCode;
    }

    const availableNumbers = await subAccountClient
      .availablePhoneNumbers(countryCode)
      .local
      .list(searchParams);

    if (!availableNumbers || availableNumbers.length === 0) {
      throw new Error(`No available phone numbers found in ${countryCode}${areaCode ? ` with area code ${areaCode}` : ''}`);
    }

    // Purchase the first available number
    const numberToPurchase = availableNumbers[0].phoneNumber;
    log.info(`Purchasing phone number: ${numberToPurchase}`);

    const purchasedNumber = await subAccountClient.incomingPhoneNumbers.create({
      phoneNumber: numberToPurchase,
      voiceUrl: `${env.APP_BASE_URL}/twilio/outbound`,
      voiceMethod: 'POST',
      smsUrl: `${env.APP_BASE_URL}/twilio/sms/webhook`,
      smsMethod: 'POST',
      friendlyName: `Agent Phone Number`
    });

    log.info(`Phone number purchased successfully: ${purchasedNumber.phoneNumber} (SID: ${purchasedNumber.sid})`);

    return {
      phoneNumber: purchasedNumber.phoneNumber,
      sid: purchasedNumber.sid,
      friendlyName: purchasedNumber.friendlyName
    };
  } catch (error) {
    log.error('Error purchasing phone number:', error);
    throw new Error(`Failed to purchase phone number: ${error.message}`);
  }
}

/**
 * Create Twilio Elastic SIP Trunk in subaccount
 * According to Twilio docs: https://www.twilio.com/docs/sip-trunking/api
 * Subaccounts can have their own SIP trunks - must use subaccount credentials
 * 
 * @param {string} subAccountSid - Twilio sub-account SID
 * @param {string} subAccountAuthToken - Twilio sub-account auth token
 * @returns {Promise<{trunkSid: string, terminationUri: string, username: string, password: string}>}
 */
/**
 * Create Twilio Elastic SIP Trunk in subaccount using direct REST API calls
 * Reference: https://www.twilio.com/docs/sip-trunking/api
 * Subaccounts can have their own SIP trunks - must use direct HTTP requests
 * 
 * @param {string} subAccountSid - Twilio sub-account SID
 * @param {string} subAccountAuthToken - Twilio sub-account auth token
 * @param {string} phoneNumberSid - Phone number SID to associate with the trunk (optional)
 * @returns {Promise<{trunkSid: string, terminationUri: string, username: string, password: string}>}
 */
async function createTwilioSipTrunkInSubaccount(subAccountSid, subAccountAuthToken, phoneNumberSid = null) {
  try {
    const trunkingBaseUrl = 'https://trunking.twilio.com/v1';
    const apiBaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${subAccountSid}`;
    const auth = Buffer.from(`${subAccountSid}:${subAccountAuthToken}`).toString('base64');

    log.info('Creating Elastic SIP Trunk in subaccount using REST API...');

    // Step 1: Create Elastic SIP Trunk FIRST
    // Reference: https://www.twilio.com/docs/sip-trunking/api/trunk-resource
    log.info('Creating Elastic SIP Trunk...');
    const trunkResponse = await axios.post(
      `${trunkingBaseUrl}/Trunks`,
      new URLSearchParams({
        FriendlyName: `Retell SIP Trunk ${Date.now()}`
      }),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const trunk = trunkResponse.data;

    // Step 2: Create a Credential List using SIP API (NOT trunking API)
    // Reference: Credential Lists must be created via SIP API endpoint
    log.info('Creating SIP Credential List...');
    const credentialListResponse = await axios.post(
      `${apiBaseUrl}/SIP/CredentialLists.json`,
      new URLSearchParams({
        FriendlyName: `Retell SIP Credentials ${Date.now()}`
      }),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const credentialList = credentialListResponse.data;

    // Step 3: Create credentials for the credential list
    log.info('Creating SIP Credentials...');
    const sipUsername = `retell_${subAccountSid.substring(2, 10)}_${Date.now().toString().slice(-6)}`;
    
    // Generate a strong password that meets Twilio's requirements:
    // - Minimum 12 characters
    // - At least one uppercase letter
    // - At least one lowercase letter
    // - At least one digit
    const generateStrongPassword = () => {
      const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const lowercase = 'abcdefghijklmnopqrstuvwxyz';
      const digits = '0123456789';
      const allChars = uppercase + lowercase + digits;
      
      // Ensure at least one of each required character type
      let password = '';
      password += uppercase[Math.floor(Math.random() * uppercase.length)]; // At least 1 uppercase
      password += lowercase[Math.floor(Math.random() * lowercase.length)]; // At least 1 lowercase
      password += digits[Math.floor(Math.random() * digits.length)]; // At least 1 digit
      
      // Fill the rest to make it 16 characters (more than minimum 12)
      const remainingLength = 16 - password.length;
      for (let i = 0; i < remainingLength; i++) {
        password += allChars[Math.floor(Math.random() * allChars.length)];
      }
      
      // Shuffle the password to randomize character positions
      return password.split('').sort(() => Math.random() - 0.5).join('');
    };
    
    const sipPassword = generateStrongPassword();

    const credentialResponse = await axios.post(
      `${apiBaseUrl}/SIP/CredentialLists/${credentialList.sid}/Credentials.json`,
      new URLSearchParams({
        Username: sipUsername,
        Password: sipPassword
      }),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    const credential = credentialResponse.data;

    // Step 4: Associate credential list with trunk
    log.info('Associating credentials with SIP Trunk...');
    await axios.post(
      `${trunkingBaseUrl}/Trunks/${trunk.sid}/CredentialLists`,
      new URLSearchParams({
        CredentialListSid: credentialList.sid
      }),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    // Step 5: Configure Termination SIP URI for the trunk
    // Generate a random domain name prefix for the termination URI
    // The termination URI format will be: {randomDomain}.pstn.twilio.com
    const randomDomainPrefix = `retell-${crypto.randomBytes(8).toString('hex')}-${Date.now().toString().slice(-6)}`;
    let terminationUri = `${randomDomainPrefix}.pstn.twilio.com`;
    log.info('Configuring Termination SIP URI domain name...');
    try {
      // Update trunk with custom domain name - this sets the "Termination SIP URI" field in console
      // Provide the full termination URI domain name ending with twilio.com
      const updateResponse = await axios.post(
        `${trunkingBaseUrl}/Trunks/${trunk.sid}`,
        new URLSearchParams({
          DomainName: terminationUri // Full termination URI domain (must end with twilio.com)
        }),
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      log.info(`Termination SIP URI domain configured: ${terminationUri}`);
    } catch (uriError) {
      log.warn(`Failed to configure termination URI domain: ${uriError.message}`);
      if (uriError.response?.data) {
        log.warn('Twilio API response:', uriError.response.data);
      }
      // Fallback: Use the default trunk SID format if custom domain fails
      terminationUri = `${trunk.sid}.pstn.twilio.com`;
      log.info(`Using fallback termination URI: ${terminationUri}`);
    }

    // Step 6: Associate phone number with trunk (if provided)
    if (phoneNumberSid) {
      log.info(`Associating phone number ${phoneNumberSid} with SIP Trunk...`);
      try {
        // Associate phone number with trunk using Trunking API
        await axios.post(
          `${trunkingBaseUrl}/Trunks/${trunk.sid}/PhoneNumbers`,
          new URLSearchParams({
            PhoneNumberSid: phoneNumberSid
          }),
          {
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        log.info(`Phone number ${phoneNumberSid} associated with trunk successfully`);
      } catch (phoneError) {
        log.warn(`Failed to associate phone number via Trunking API, trying alternative method: ${phoneError.message}`);
        
        // Alternative: Update phone number directly via IncomingPhoneNumbers API to set trunk_sid
        try {
          log.info(`Updating phone number ${phoneNumberSid} to set TrunkSid...`);
          await axios.post(
            `${apiBaseUrl}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
            new URLSearchParams({
              TrunkSid: trunk.sid
            }),
            {
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );
          log.info(`Phone number ${phoneNumberSid} associated with trunk via IncomingPhoneNumbers API`);
        } catch (altError) {
          log.warn(`Could not associate phone number with trunk: ${altError.message}`);
          if (altError.response?.data) {
            log.warn('Twilio API error details:', altError.response.data);
          }
          log.info('Note: You may need to manually associate the phone number with the trunk in Twilio Console');
          // Don't fail the entire operation if phone association fails
        }
      }
    }

    log.info(`SIP Trunk created successfully: ${trunk.sid}`);
    log.info(`Termination URI: ${terminationUri}`);

    return {
      trunkSid: trunk.sid,
      terminationUri,
      username: sipUsername,
      password: sipPassword,
      credentialListSid: credentialList.sid,
      credentialSid: credential.sid
    };
  } catch (error) {
    log.error('Error creating Twilio SIP Trunk in subaccount:', error);
    
    // Provide detailed error information
    if (error.response) {
      log.error('Twilio API Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
      
      if (error.response.status === 401 || error.response.status === 403) {
        throw new Error(`Twilio authentication failed: ${error.response.data?.message || error.message}`);
      }
    }
    
    throw new Error(`Failed to create Twilio SIP Trunk: ${error.message}`);
  }
}

/**
 * Generate SIP credentials for Retell integration with Twilio sub-account
 * First attempts to create an Elastic SIP Trunk, falls back to account SID format if needed
 * 
 * @param {string} subAccountSid - Twilio sub-account SID
 * @param {string} subAccountAuthToken - Twilio sub-account auth token
 * @param {boolean} useTrunk - Whether to create a SIP trunk (default: true)
 * @param {string} phoneNumberSid - Phone number SID to associate with trunk (optional)
 * @returns {Promise<{terminationUri: string, username: string, password: string, trunkSid?: string}>}
 */
async function generateSipCredentialsForRetell(subAccountSid, subAccountAuthToken, useTrunk = true, phoneNumberSid = null) {
  try {
    if (useTrunk) {
      // Try to create a proper SIP trunk in the subaccount
      try {
        const trunk = await createTwilioSipTrunkInSubaccount(subAccountSid, subAccountAuthToken, phoneNumberSid);
        return trunk;
      } catch (trunkError) {
        // If trunking is not available (expected for subaccounts), use fallback
        if (trunkError.message === 'TRUNKING_NOT_AVAILABLE') {
          log.info('SIP Trunking API not available on subaccount - using account SID format (this is normal)');
        } else {
          log.warn('Failed to create SIP trunk, using account SID format:', trunkError.message);
        }
        // Fall through to use account SID format
      }
    }

    // Fallback: Use account SID format (Twilio's default SIP endpoint)
    // Format: {accountSid}.pstn.twilio.com
    const terminationUri = `${subAccountSid}.pstn.twilio.com`;
    const sipUsername = subAccountSid;
    const sipPassword = subAccountAuthToken;

    log.info(`Using termination URI: ${terminationUri} (account SID format)`);
    log.info(`SIP Username: ${sipUsername.substring(0, 8)}...`);

    return {
      terminationUri,
      username: sipUsername,
      password: sipPassword,
      fallback: true
    };
  } catch (error) {
    log.error('Error generating SIP credentials:', error);
    throw new Error(`Failed to generate SIP credentials: ${error.message}`);
  }
}

/**
 * Import a phone number to Retell for outbound calls
 * @param {string} phoneNumber - Phone number in E.164 format
 * @param {string} phoneNumberSid - Twilio phone number SID (for associating with trunk)
 * @param {string} agentId - Retell agent ID to associate with this number
 * @param {string} twilioSubAccountSid - Twilio sub-account SID
 * @param {string} twilioSubAccountAuthToken - Twilio sub-account auth token
 * @param {object} retellClient - Retell SDK client instance
 * @param {string} nickname - Optional nickname for the phone number
 * @returns {Promise<object>}
 */
export async function registerPhoneNumberWithRetell(
  phoneNumber, 
  phoneNumberSid,
  agentId, 
  twilioSubAccountSid,
  twilioSubAccountAuthToken,
  retellClient,
  nickname = null
) {
  try {
    log.info(`Importing phone number ${phoneNumber} to Retell for agent ${agentId}`);

    // Generate SIP credentials for Retell integration
    // This will create a SIP trunk and associate the phone number with it
    log.info('Generating SIP credentials for Retell integration...');
    const sipTrunk = await generateSipCredentialsForRetell(twilioSubAccountSid, twilioSubAccountAuthToken, true, phoneNumberSid);

    // Prepare import configuration according to Retell API
    // Reference: https://docs.retellai.com/api-references/import-phone-number
    const importConfig = {
      phone_number: phoneNumber,
      termination_uri: sipTrunk.terminationUri, // Use SIP trunk termination URI
      sip_trunk_auth_username: sipTrunk.username, // Use SIP trunk credentials
      sip_trunk_auth_password: sipTrunk.password, // Use SIP trunk credentials
      outbound_agent_id: agentId, // Required for outbound calls
      inbound_agent_id: agentId, // Optional: can be null if not accepting inbound calls
      nickname: nickname || `Agent ${agentId.substring(0, 8)} Number`,
      inbound_webhook_url: `${env.APP_BASE_URL}/retell/webhook` // Optional webhook URL
    };

    log.info(`Importing phone number with termination URI: ${sipTrunk.terminationUri}`);

    // Import the phone number to Retell
    const result = await retellClient.phoneNumber.import(importConfig);
    
    log.info(`Phone number ${phoneNumber} successfully imported to Retell`);
    log.info(`Retell phone number response:`, {
      phone_number: result.phone_number,
      phone_number_type: result.phone_number_type,
      inbound_agent_id: result.inbound_agent_id,
      outbound_agent_id: result.outbound_agent_id
    });

    return {
      ...result,
      sipTrunkInfo: {
        terminationUri: sipTrunk.terminationUri,
        username: sipTrunk.username,
        ...(sipTrunk.trunkSid && { trunkSid: sipTrunk.trunkSid }),
        ...(sipTrunk.fallback && { 
          note: 'Using account SID format. You can manually create a SIP trunk in Twilio Console and update termination_uri in Retell dashboard.'
        })
      }
    };
  } catch (error) {
    log.error('Error importing phone number to Retell:', error);
    
    // If the phone number already exists, try to update it instead
    if (error.message && error.message.includes('already exists') || error.status === 400) {
      log.info(`Phone number ${phoneNumber} already exists in Retell, attempting to update...`);
      
      try {
        const updateResult = await retellClient.phoneNumber.update(phoneNumber, {
          inbound_agent_id: agentId,
          outbound_agent_id: agentId,
        });
        log.info(`Phone number ${phoneNumber} updated in Retell`);
        return updateResult;
      } catch (updateError) {
        log.error('Error updating phone number in Retell:', updateError);
        throw new Error(`Failed to update phone number in Retell: ${updateError.message}`);
      }
    }
    
    throw new Error(`Failed to import phone number to Retell: ${error.message}`);
  }
}

/**
 * Delete/release a phone number from a Twilio sub-account
 * @param {string} subAccountSid - Sub-account SID
 * @param {string} subAccountAuthToken - Sub-account auth token
 * @param {string} phoneSid - Phone number SID to delete
 * @returns {Promise<boolean>}
 */
export async function releasePhoneNumber(subAccountSid, subAccountAuthToken, phoneSid) {
  try {
    log.info(`Releasing phone number ${phoneSid} from sub-account ${subAccountSid}`);

    const Twilio = (await import('twilio')).default;
    const subAccountClient = Twilio(subAccountSid, subAccountAuthToken);

    await subAccountClient.incomingPhoneNumbers(phoneSid).remove();

    log.info(`Phone number ${phoneSid} released successfully`);
    return true;
  } catch (error) {
    log.error('Error releasing phone number:', error);
    throw new Error(`Failed to release phone number: ${error.message}`);
  }
}

/**
 * Close/suspend a Twilio sub-account
 * @param {string} subAccountSid - Sub-account SID to close
 * @returns {Promise<boolean>}
 */
export async function closeTwilioSubAccount(subAccountSid) {
  try {
    log.info(`Closing Twilio sub-account: ${subAccountSid}`);

    await twilio.api.accounts(subAccountSid).update({
      status: 'closed'
    });

    log.info(`Twilio sub-account closed: ${subAccountSid}`);
    return true;
  } catch (error) {
    log.error('Error closing Twilio sub-account:', error);
    throw new Error(`Failed to close Twilio sub-account: ${error.message}`);
  }
}

