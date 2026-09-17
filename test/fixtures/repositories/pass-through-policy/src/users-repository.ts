export const usersRepository = {
  findUsers(filter: { status?: string }) {
    return database.users.findMany(filter);
  },
};
