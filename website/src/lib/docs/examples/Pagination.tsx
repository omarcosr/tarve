import { Pagination } from "@tarve/core";

let page = 3;

<Pagination
  page={page}
  pageCount={12}
  onPageChange={(next) => {
    page = next;
  }}
/>;
