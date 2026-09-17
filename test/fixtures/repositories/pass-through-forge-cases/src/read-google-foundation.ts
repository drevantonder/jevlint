export interface GoogleFoundationOperations<R> {
  readonly read: (
    props: GoogleFoundationProps,
    policy: ModelArmorPolicy,
    owned: boolean,
  ) => R;
}

type GoogleFoundationProps = { readonly projectId: string };
type ModelArmorPolicy = { readonly protected: boolean };

export const readGoogleFoundation = <R>(
  operations: GoogleFoundationOperations<R>,
  props: GoogleFoundationProps,
  policy: ModelArmorPolicy,
  owned = false,
) => operations.read(props, policy, owned);

export const GoogleFoundationProvider = <R>(
  operations: GoogleFoundationOperations<R>,
  policy: ModelArmorPolicy,
) => ({
  read(props: GoogleFoundationProps) {
    return readGoogleFoundation(operations, props, policy, true);
  },
});
