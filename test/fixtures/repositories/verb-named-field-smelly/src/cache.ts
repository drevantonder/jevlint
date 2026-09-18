export class RenderCache {
  computeKey = "";
  count = 0;
  refresh: () => void = () => {};
  keys(): string[] {
    return [this.computeKey];
  }
}
