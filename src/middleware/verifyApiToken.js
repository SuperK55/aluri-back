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

export const verifyApiToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: 'No token provided'
      });
    }

    const token = authHeader.substring(7);
    
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid token format'
      });
    }

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

    if (token.length < 32) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid token'
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
