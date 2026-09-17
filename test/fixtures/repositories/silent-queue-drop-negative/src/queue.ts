export const queue = {
  publish: (message: string): boolean => message.length > 0,
  on: (event: string, listener: () => void): void => {
    void event;
    void listener;
  },
};
