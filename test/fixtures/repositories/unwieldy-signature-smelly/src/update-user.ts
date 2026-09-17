export interface UserData {
  name: string;
  email: string;
}

const store = {
  write(_id: string, _data: UserData): void {},
};

const mailer = {
  send(_id: string): void {},
};

export function updateUser(
  id: string,
  actorId: string,
  data: UserData,
  cache: Map<string, UserData> | undefined,
  notify: boolean,
  force: boolean,
  retries: number,
): boolean {
  if (force) {
    store.write(id, data);
  } else {
    store.write(id, data);
  }
  if (notify) {
    mailer.send(actorId);
  }
  return true;
}

export function renameUser(id: string, data: UserData): boolean {
  store.write(id, data);
  return true;
}

export function noArguments(): boolean {
  return true;
}
