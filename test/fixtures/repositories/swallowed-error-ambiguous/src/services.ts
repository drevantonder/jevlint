export interface Profile {
  id: string;
  displayName: string;
}

export declare const profileService: {
  load(userId: string): Promise<Profile | null>;
};

export declare const profileCache: {
  get(userId: string): Promise<Profile | null>;
};

export declare const logger: {
  warn(message: string, context: object): void;
};
