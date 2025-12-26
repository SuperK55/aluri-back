import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { env } from '../config/env.js';

const JWT_SECRET = env.JWT_SECRET || 'geniumed-secret-key-change-in-production';

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const isJwtToken = (token) => {
  const parts = token.split('.');
  return parts.length === 3;
};

/**
 * Flexible API token verification middleware
 * Accepts token from:
 * 1. Authorization header: "Bearer <token>"
 * 2. Query parameter: ?api_token=<token>
 * 3. Form field: { api_token: "<token>" }
 * 
 * This is designed for webhook integrations (Google Forms, RD Station, Typeform)
 * that don't support custom headers easily.
 */
export const verifyApiTokenFlexible = async (req, res, next) => {
  try {
    let token = null;
    
    // Try Authorization header first (most secure)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    // Fallback to query parameter (for webhooks)
    if (!token && req.query.api_token) {
      token = req.query.api_token;
    }
    
    // Fallback to form field (for POST form submissions)
    // Support both regular form fields and Typeform format
    if (!token && req.body) {
      // Regular form field (Google Forms, webforms)
      if (req.body.api_token) {
        token = req.body.api_token;
        // Remove token from body to prevent it from being saved as lead data
        delete req.body.api_token;
      }
      // Typeform format (form_response.variables)
      else if (req.body.form_response && req.body.form_response.variables) {
        const apiToken = req.body.form_response.variables.find(variable => variable.key === 'api_token');
        if (apiToken) {
          token = apiToken.text;
          // Remove token from body to prevent it from being saved as lead data
          const index = req.body.form_response.variables.findIndex(v => v.key === 'api_token');
          if (index > -1) {
            req.body.form_response.variables.splice(index, 1);
          }
        }
      }
    }
    
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'No API token provided. Include it in Authorization header, query parameter (?api_token=...), or form field (api_token).'
      });
    }
    
    if (!token || token.trim().length === 0) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid token format'
      });
    }

    // Handle JWT tokens (for user sessions)
    if (isJwtToken(token)) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const { data: user, error: userError } = await supa
          .from('users')
          .select('id, email, name, role, service_type, is_active')
          .eq('id', decoded.id)
          .eq('is_active', true)
          .single();

        if (userError || !user) {
          return res.status(401).json({
            ok: false,
            error: 'Invalid JWT token or user not found'
          });
        }

        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          service_type: user.service_type
        };
        req.authType = 'jwt';

        return next();
      } catch (jwtError) {
        log.error('JWT verification failed:', jwtError.message);
      }
    }

    // Handle API tokens
    if (token.length < 32) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid token format'
      });
    }

    const tokenHash = hashToken(token);

    const { data: apiToken, error: tokenError } = await supa
      .from('api_tokens')
      .select('id, owner_id, name, is_active')
      .eq('token_hash', tokenHash)
      .eq('is_active', true)
      .single();

    if (tokenError || !apiToken) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or inactive API token'
      });
    }

    const { data: user, error: userError } = await supa
      .from('users')
      .select('id, email, name, role, service_type, is_active')
      .eq('id', apiToken.owner_id)
      .eq('is_active', true)
      .single();

    if (userError || !user) {
      return res.status(401).json({
        ok: false,
        error: 'Token owner not found or inactive'
      });
    }

    // Update last used timestamp (non-blocking)
    supa
      .from('api_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', apiToken.id)
      .then(() => {})
      .catch((err) => log.error('Failed to update token last_used_at:', err));

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      service_type: user.service_type
    };
    req.apiToken = {
      id: apiToken.id,
      name: apiToken.name
    };
    req.authType = 'api_token';

    next();
  } catch (error) {
    log.error('Token verification error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Authentication error'
    });
  }
};

