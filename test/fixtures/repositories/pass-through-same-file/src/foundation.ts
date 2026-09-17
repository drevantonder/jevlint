type Operations<R> = {
  read(props: Props, policy: Policy, owned: boolean): R;
};
type Props = { projectId: string };
type Policy = { protected: boolean };

export const readFoundation = <R>(
  operations: Operations<R>,
  props: Props,
  policy: Policy,
  owned = false,
) => operations.read(props, policy, owned);

export const FoundationProvider = <R>(
  operations: Operations<R>,
  policy: Policy,
) => ({
  read(props: Props) {
    return readFoundation(operations, props, policy, true);
  },
});
