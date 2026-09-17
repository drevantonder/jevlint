const usersRepository = {
  getUserById(id: string) {
    return database.users.find(id);
  },
};

export function getUserById(id: string) {
  return usersRepository.getUserById(id);
}
