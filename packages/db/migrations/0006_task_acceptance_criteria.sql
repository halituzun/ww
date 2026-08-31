ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_criteria Array(String) DEFAULT [] AFTER description;
