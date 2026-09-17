interface UserRecord {
  firstName: string;
  lastName: string;
  displayName?: string;
}

export function doIt(x: UserRecord): UserRecord {
  const y = `${x.firstName} ${x.lastName}`.trim();
  return { ...x, displayName: y };
}

export function addDisplayName(user: UserRecord): UserRecord {
  const displayName = `${user.firstName} ${user.lastName}`.trim();
  return { ...user, displayName };
}
