export interface SelectionState {
  selectedId: string;
  isOpen: boolean;
  onSelect: (id: string) => void;
}
