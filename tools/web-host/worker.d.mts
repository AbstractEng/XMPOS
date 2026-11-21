export function clientErrors(request: Request): Promise<Response>;
export function mediaRange(request: Request, asset: Response): Promise<Response>;
declare const worker: {
  fetch(
    request: Request,
    env: { ASSETS: { fetch(request: Request): Promise<Response> } },
  ): Promise<Response>;
};
export default worker;
