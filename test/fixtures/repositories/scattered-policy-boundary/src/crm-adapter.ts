export async function fetchCrmContact(contactId: string): Promise<Contact> {
  const response = await crmClient.get(`/contacts/${contactId}`);
  if (response.status === 401 || response.status === 403) {
    throw new CrmCredentialsExpired(response.status);
  }
  return response.json();
}
