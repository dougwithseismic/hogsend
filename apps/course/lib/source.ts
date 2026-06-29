import { courses } from "collections/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/learn",
  source: courses.toFumadocsSource(),
});
