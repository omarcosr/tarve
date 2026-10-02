export interface PropDoc {
  name: string;
  type: string;
  optional: boolean;
  default?: string;
  doc?: string;
  from?: string;
}

export interface DocLink {
  name: string;
  summary: string;
}

/** A native render of the example: the `left/top/width/height` crop of a `frameWidth × frameHeight` window. */
export interface PreviewImage {
  /** Dark-theme render. */
  src: string;
  /** Light-theme render, same crop. */
  srcLight: string;
  width: number;
  height: number;
  left: number;
  top: number;
  frameWidth: number;
  frameHeight: number;
}

export interface ComponentDoc {
  name: string;
  category: { id: string; title: string };
  summary: string;
  notes?: string;
  sourceUrl: string;
  sourceLabel: string;
  generic: boolean;
  propsType?: string;
  importLine: string;
  example: string;
  props: PropDoc[];
  inherited: { from: string; props: PropDoc[] }[];
  common: string[];
  types: { name: string; code: string }[];
  preview?: PreviewImage;
  prev?: DocLink;
  next?: DocLink;
}
