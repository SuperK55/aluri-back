import crypto from 'crypto';
import axios from 'axios';
import { env } from '../config/env.js';
import Retell from 'retell-sdk';

const client = new Retell({ apiKey: env.RETELL_API_KEY });

export function normalizePhoneNumber(phone) {
  if (!phone) return phone;
  
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  if (!cleaned.startsWith('+')) {
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }
    
    if (cleaned.length === 11 && /^[1-9]\d{10}$/.test(cleaned)) {
      cleaned = '55' + cleaned;
    }
    
    cleaned = '+' + cleaned;
  }
  
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  if (!cleaned.match(e164Regex)) {
    throw new Error(`Invalid phone number format: ${phone}. Must be in E.164 format`);
  }
  
  return cleaned;
}

export function verifyRetellSignature(rawBody, signatureHeader){
  if (!signatureHeader) return false;
  const [algo, sent] = String(signatureHeader).split('=');
  if (algo !== 'sha256' || !sent) return false;
  const h = crypto.createHmac('sha256', env.RETELL_API_KEY);
  h.update(rawBody);
  return h.digest('hex') === sent;
}

export async function retellCreatePhoneCall(opts){
  try {
    if (!opts.to_number && !opts.customer_number) {
      throw new Error('Phone number (to_number or customer_number) is required');
    }

    if (!env.RETELL_FROM_NUMBER && !opts.from_number) {
      throw new Error('From number is required (set RETELL_FROM_NUMBER env var or provide from_number)');
    }

    if (!opts.agent_id) {
      throw new Error('Agent ID is required for outbound calls');
    }

    const toNumber = normalizePhoneNumber(opts.to_number || opts.customer_number);
    
    let fromNumber = env.RETELL_FROM_NUMBER;
    if (opts.from_number) {
      fromNumber = normalizePhoneNumber(opts.from_number);
    } else if (fromNumber) {
      fromNumber = normalizePhoneNumber(fromNumber);
    }

    const callParams = {
      to_number: toNumber,
      from_number: fromNumber,
      retell_llm_dynamic_variables: opts.retell_llm_dynamic_variables || {}
    };


    if (opts.metadata) {
      callParams.metadata = opts.metadata;
    }

    const r = await client.call.createPhoneCall(callParams);
    return r;
  } catch (error) {
    console.error('Retell call creation error:', error);
    throw new Error(`Failed to create Retell call: ${error.message}`);
  }
}

export async function retellDeleteAgent(agentId){
  try {
    if (!agentId) {
      throw new Error('Agent ID is required for deletion');
    }

    console.log('Deleting Retell agent:', agentId);

    const response = await client.agent.delete(agentId);
    console.log('Retell agent deleted successfully:', agentId);
    return response;
  } catch (error) {
    console.error('Retell agent deletion error:', error);
    throw new Error(`Failed to delete Retell agent: ${error.message}`);
  }
}

export async function retellCreateChat(opts) {
  try {
    if (!opts.agent_id) {
      throw new Error('Agent ID is required for chat creation');
    }

    const payload = {
      agent_id: opts.agent_id,
      retell_llm_dynamic_variables: opts.retell_llm_dynamic_variables || {}
    };

    if (opts.metadata) {
      payload.metadata = opts.metadata;
    }

    const response = await axios.post(
      'https://api.retellai.com/create-chat',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Retell chat created:', response.data.chat_id);
    return response.data;
  } catch (error) {
    console.error('Retell chat creation error:', error.response?.data || error.message);
    throw new Error(`Failed to create Retell chat: ${error.response?.data?.message || error.message}`);
  }
}

export async function retellSendChatMessage(chatId, content) {
  try {
    if (!chatId) {
      throw new Error('Chat ID is required');
    }
    if (!content) {
      throw new Error('Message content is required');
    }

    const payload = {
      chat_id: chatId,
      content: content
    };

    const response = await axios.post(
      'https://api.retellai.com/create-chat-completion',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Retell chat completion received');
    return response.data;
  } catch (error) {
    console.error('Retell chat completion error:', error.response?.data || error.message);
    throw new Error(`Failed to send chat message: ${error.response?.data?.message || error.message}`);
  }
}

export async function retellEndChat(chatId) {
  try {
    if (!chatId) {
      throw new Error('Chat ID is required');
    }

    const response = await axios.patch(
      `https://api.retellai.com/end-chat/${chatId}`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Retell chat ended:', chatId);
    return response.data;
  } catch (error) {
    console.error('Retell end chat error:', error.response?.data || error.message);
    throw new Error(`Failed to end Retell chat: ${error.response?.data?.message || error.message}`);
  }
}

export async function retellGetChat(chatId) {
  try {
    if (!chatId) {
      throw new Error('Chat ID is required');
    }

    const response = await axios.get(
      `https://api.retellai.com/get-chat/${chatId}`,
      {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Retell get chat error:', error.response?.data || error.message);
    throw new Error(`Failed to get Retell chat: ${error.response?.data?.message || error.message}`);
  }
}

export async function retellUpdateChat(chatId, opts) {
  try {
    if (!chatId) {
      throw new Error('Chat ID is required');
    }

    const payload = {};

    if (opts.override_dynamic_variables) {
      payload.override_dynamic_variables = opts.override_dynamic_variables;
    }

    if (opts.metadata) {
      payload.metadata = opts.metadata;
    }

    if (opts.data_storage_setting) {
      payload.data_storage_setting = opts.data_storage_setting;
    }

    if (opts.custom_attributes) {
      payload.custom_attributes = opts.custom_attributes;
    }

    const response = await axios.patch(
      `https://api.retellai.com/update-chat/${chatId}`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Retell chat updated:', chatId);
    return response.data;
  } catch (error) {
    console.error('Retell update chat error:', error.response?.data || error.message);
    throw new Error(`Failed to update Retell chat: ${error.response?.data?.message || error.message}`);
  }
}
