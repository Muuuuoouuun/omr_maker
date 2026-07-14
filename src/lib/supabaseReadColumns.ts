// Canonical reads reconstruct domain objects from payload and only need the
// explicit scope columns layered on top. Centralized projections avoid
// transferring every analytical fact column and keep future schema additions
// from silently increasing dashboard/history response size.
export const SUPABASE_EXAM_READ_COLUMNS = "id, organization_id, class_id, title, payload, created_by_user_id, created_at, updated_at, archived";

export const SUPABASE_ATTEMPT_READ_COLUMNS = "organization_id, class_id, assignment_id, student_profile_id, payload";
