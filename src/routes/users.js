import { Router } from 'express';
import bcrypt from 'bcrypt';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { verifyJWT } from '../middleware/verifyJWT.js';

const router = Router();
const SALT_ROUNDS = 12;

// Admin-only middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Admin access required'
    });
  }
  next();
};

// Apply JWT verification to all routes
// COMMENTED OUT: This was causing all unmatched routes to require authentication
// router.use(verifyJWT);
// Instead, verifyJWT is now applied to each individual route below

// GET /api/users - Get all users (admin only)
router.get('/users', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, role, status } = req.query;
    const offset = (page - 1) * limit;

    // Build query
    let query = supa
      .from('users')
      .select('id, email, name, service_type, role, is_active, location, created_at, updated_at, last_login')
      .order('created_at', { ascending: false });

    // Apply filters
    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    if (role && role !== 'all') {
      query = query.eq('role', role);
    }

    if (status && status !== 'all') {
      const isActive = status === 'active';
      query = query.eq('is_active', isActive);
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data: users, error, count } = await query;

    if (error) {
      log.error('Error fetching users:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch users'
      });
    }

    res.json({
      ok: true,
      users: users || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    log.error('Users fetch error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// GET /api/users/stats - Get user statistics (admin only)
router.get('/users/stats', verifyJWT, requireAdmin, async (req, res) => {
  try {
    // Get total users count
    const { count: totalUsers } = await supa
      .from('users')
      .select('*', { count: 'exact', head: true });

    // Get active users count
    const { count: activeUsers } = await supa
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Get new users this month (in São Paulo timezone)
    const { getStartOfDaySaoPaulo } = await import('../utils/timezone.js');
    const now = getStartOfDaySaoPaulo();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const { count: newUsersThisMonth } = await supa
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfMonth.toISOString());

    // Get recent activity (last 10 user activities)
    const { data: recentActivity } = await supa
      .from('users')
      .select('id, name, created_at, updated_at, last_login')
      .order('updated_at', { ascending: false })
      .limit(10);

    res.json({
      ok: true,
      stats: {
        totalUsers: totalUsers || 0,
        activeUsers: activeUsers || 0,
        newUsersThisMonth: newUsersThisMonth || 0,
        recentActivity: recentActivity || []
      }
    });

  } catch (error) {
    log.error('User stats error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// POST /api/users - Create new user (admin only)
router.post('/users', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const {
      email,
      password,
      name,
      specialty,
      service_type = 'clinic',
      role = 'owner',
      is_active = true,
      location
    } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({
        ok: false,
        error: 'Email, password, and name are required'
      });
    }

    if (!location || typeof location !== 'string' || !location.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Location is required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'Password must be at least 8 characters long'
      });
    }

    if (!['admin', 'owner'].includes(role)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid role. Must be admin or owner'
      });
    }

    // Validate specialty if provided
    if (specialty && !['clinic', 'real_estate', 'consortia', 'insurance', 'beauty_clinic'].includes(specialty)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid specialty. Must be one of: clinic, real_estate, consortia, insurance, beauty_clinic'
      });
    }

    // Validate service_type if provided
    if (service_type && !['clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia'].includes(service_type)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid service_type. Must be one of: clinic, beauty_clinic, real_estate, insurance, consortia'
      });
    }

    // Check if user already exists
    const { data: existingUser } = await supa
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: 'User with this email already exists'
      });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const { data: newUser, error: userError } = await supa
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password: password_hash,
        name,
        specialty: specialty || null,
        service_type: service_type || 'clinic',
        role,
        is_active,
        location: location.trim()
      })
      .select('id, email, name, specialty, service_type, role, is_active, location, created_at, updated_at')
      .single();

    if (userError) {
      log.error('User creation error:', userError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create user'
      });
    }

    res.status(201).json({
      ok: true,
      message: 'User created successfully',
      user: newUser
    });

  } catch (error) {
    log.error('User creation error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// GET /api/users/me - Get current user info
router.get('/users/me', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error } = await supa
      .from('users')
      .select('id, email, name, service_type, role, is_active, location, working_hours, date_specific_availability, timezone, social_proof_enabled, social_proof_text, google_calendar_id, calendar_sync_enabled, last_calendar_sync, twilio_phone_number, twilio_subaccount_sid')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    res.json(user);

  } catch (error) {
    log.error('Get current user error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get user information'
    });
  }
});

// PUT /api/users/me/working-hours - Update working hours for beauty clinic
router.put('/users/me/working-hours', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { working_hours, date_specific_availability, timezone } = req.body;

    // Validate that user is beauty_clinic
    const { data: user, error: userError } = await supa
      .from('users')
      .select('service_type')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    if (user.service_type !== 'beauty_clinic') {
      return res.status(403).json({
        ok: false,
        error: 'Working hours at user level are only for beauty clinic service type'
      });
    }

    // Update working hours
    const updateData = {};
    if (working_hours !== undefined) updateData.working_hours = working_hours;
    if (date_specific_availability !== undefined) updateData.date_specific_availability = date_specific_availability;
    if (timezone) updateData.timezone = timezone;

    const { data: updatedUser, error: updateError } = await supa
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    log.info(`Working hours updated for user ${userId}`);

    res.json({
      ok: true,
      message: 'Working hours updated successfully',
      working_hours: updatedUser.working_hours,
      date_specific_availability: updatedUser.date_specific_availability,
      timezone: updatedUser.timezone
    });

  } catch (error) {
    log.error('Update working hours error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update working hours'
    });
  }
});

// GET /api/users/:id - Get specific user (admin only)
router.get('/users/:id', verifyJWT, requireAdmin, async (req, res) => {
  try{
    const { id } = req.params;

    const { data: user, error } = await supa
      .from('users')
      .select('id, email, name, service_type, role, is_active, location, created_at, updated_at, last_login')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    res.json({
      ok: true,
      user
    });

  } catch (error) {
    log.error('User fetch error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// PATCH /api/users/:id - Update user (admin only)
router.patch('/users/:id', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      email,
      name,
      specialty,
      service_type,
      role,
      is_active,
      location
    } = req.body;

    // Build update object
    const updates = {};
    if (email !== undefined) updates.email = email.toLowerCase();
    if (name !== undefined) updates.name = name;
    if (specialty !== undefined) updates.specialty = specialty;
    if (role !== undefined) {
      if (!['admin', 'owner'].includes(role)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid role. Must be admin or owner'
        });
      }
      updates.role = role;
    }
    if (specialty !== undefined) {
      if (specialty && !['clinic', 'real_estate', 'consortia', 'insurance', 'beauty_clinic'].includes(specialty)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid specialty. Must be one of: clinic, real_estate, consortia, insurance, beauty_clinic'
        });
      }
      updates.specialty = specialty;
    }
    if (service_type !== undefined) {
      if (service_type && !['clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia'].includes(service_type)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid service_type. Must be one of: clinic, beauty_clinic, real_estate, insurance, consortia'
        });
      }
      updates.service_type = service_type;
    }
    if (is_active !== undefined) updates.is_active = is_active;
    if (location !== undefined) {
      if (location && (typeof location !== 'string' || !location.trim())) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid location. Must be a non-empty string when provided'
        });
      }
      updates.location = location ? location.trim() : null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid fields to update'
      });
    }

    // Check if email is being changed and if it already exists
    if (email) {
      const { data: existingUser } = await supa
        .from('users')
        .select('id')
        .eq('email', email.toLowerCase())
        .neq('id', id)
        .single();

      if (existingUser) {
        return res.status(409).json({
          ok: false,
          error: 'User with this email already exists'
        });
      }
    }

    // Update user
    const { data: updatedUser, error: updateError } = await supa
      .from('users')
      .update(updates)
      .eq('id', id)
      .select('id, email, name, service_type, role, is_active, location, created_at, updated_at, last_login')
      .single();

    if (updateError) {
      log.error('User update error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update user'
      });
    }

    if (!updatedUser) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    res.json({
      ok: true,
      message: 'User updated successfully',
      user: updatedUser
    });

  } catch (error) {
    log.error('User update error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// DELETE /api/users/:id - Delete user (admin only)
router.delete('/users/:id', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent admin from deleting themselves
    if (id === req.user.id) {
      return res.status(400).json({
        ok: false,
        error: 'You cannot delete your own account'
      });
    }

    // Check if user exists
    const { data: user, error: userError } = await supa
      .from('users')
      .select('id, email, name')
      .eq('id', id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    // Delete user
    const { error: deleteError } = await supa
      .from('users')
      .delete()
      .eq('id', id);

    if (deleteError) {
      log.error('User deletion error:', deleteError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to delete user'
      });
    }

    res.json({
      ok: true,
      message: 'User deleted successfully',
      deletedUser: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });

  } catch (error) {
    log.error('User deletion error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// POST /api/users/:id/reset-password - Reset user password (admin only)
router.post('/users/:id/reset-password', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        ok: false,
        error: 'New password is required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'Password must be at least 8 characters long'
      });
    }

    // Check if user exists
    const { data: user, error: userError } = await supa
      .from('users')
      .select('id, email, name')
      .eq('id', id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    // Hash new password
    const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Update password
    const { error: updateError } = await supa
      .from('users')
      .update({ password: password_hash })
      .eq('id', id);

    if (updateError) {
      log.error('Password reset error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to reset password'
      });
    }

    res.json({
      ok: true,
      message: 'Password reset successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });

  } catch (error) {
    log.error('Password reset error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// POST /api/users/:id/toggle-status - Toggle user active status (admin only)
router.post('/users/:id/toggle-status', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent admin from deactivating themselves
    if (id === req.user.id) {
      return res.status(400).json({
        ok: false,
        error: 'You cannot deactivate your own account'
      });
    }

    // Get current user status
    const { data: user, error: userError } = await supa
      .from('users')
      .select('id, email, name, is_active')
      .eq('id', id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    // Toggle status
    const newStatus = !user.is_active;

    const { data: updatedUser, error: updateError } = await supa
      .from('users')
      .update({ is_active: newStatus })
      .eq('id', id)
      .select('id, email, name, is_active')
      .single();

    if (updateError) {
      log.error('Status toggle error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update user status'
      });
    }

    res.json({
      ok: true,
      message: `User ${newStatus ? 'activated' : 'deactivated'} successfully`,
      user: updatedUser
    });

  } catch (error) {
    log.error('Status toggle error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

export default router;
