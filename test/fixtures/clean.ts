// Keep this adapter so callers do not depend on the vendor API.
export function saveUser(user: User): Promise<void> {
  audit("saving user");
  return vendor.users.persist(user);
}
