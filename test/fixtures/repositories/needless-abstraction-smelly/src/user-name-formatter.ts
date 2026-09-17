export interface UserNameFormatter {
  format(user: User): string;
}

export class DefaultUserNameFormatter implements UserNameFormatter {
  format(user: User): string {
    return `${user.firstName} ${user.lastName}`;
  }
}
