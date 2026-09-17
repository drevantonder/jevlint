import debounce from "lodash.debounce";

export const saveDraft = debounce((text: string) => {
  persist(text);
}, 300);

function persist(_text: string): void {}
