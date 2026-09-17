const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const accessOAuthRandom = () =>
  base64url(crypto.getRandomValues(new Uint8Array(48)));

export const createAccessPkce = async (random: () => string = accessOAuthRandom) => {
  const verifier = random();
  return { verifier };
};
