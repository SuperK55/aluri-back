-- Quick script to set a user's service_type to 'beauty_clinic'
-- Replace 'your-email@example.com' with the actual user email

-- Option 1: Update by email
UPDATE users 
SET service_type = 'beauty_clinic', updated_at = now()
WHERE email = 'your-email@example.com';

-- Option 2: Update by user ID (if you know the UUID)
-- UPDATE users 
-- SET service_type = 'beauty_clinic', updated_at = now()
-- WHERE id = 'your-user-uuid-here';

-- Option 3: List all users to find the right one
SELECT id, email, name, service_type, created_at 
FROM users 
ORDER BY created_at DESC;

-- Option 4: Check if treatments table exists and has data
SELECT COUNT(*) as treatment_count FROM treatments;

-- Option 5: Check if the user has any treatments
SELECT 
  u.email,
  u.name,
  u.service_type,
  COUNT(t.id) as treatment_count
FROM users u
LEFT JOIN treatments t ON u.id = t.owner_id
GROUP BY u.id, u.email, u.name, u.service_type
ORDER BY u.created_at DESC;
