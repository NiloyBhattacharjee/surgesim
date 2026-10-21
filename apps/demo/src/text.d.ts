/** The build embeds .yaml files as text (esbuild's text loader). */
declare module "*.yaml" {
  const text: string;
  export default text;
}
