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
  prev?: DocLink;
  next?: DocLink;
}
