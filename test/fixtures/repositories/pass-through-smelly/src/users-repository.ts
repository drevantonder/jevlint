export const usersRepository = {
  getUserById(id: string) {
    return database.users.find(id);
  },
};
