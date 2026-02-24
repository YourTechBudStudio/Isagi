import { createServer } from "node:http";

import { OpenAPIHandler } from "@orpc/openapi/node";
import { onError } from "@orpc/server";
import { CORSPlugin } from "@orpc/server/plugins";

import { router } from "./router";

const handler = new OpenAPIHandler(router, {
  plugins: [new CORSPlugin()],
  interceptors: [
    onError(error => {
      console.error(error);
    }),
  ],
});

const port = Number.parseInt(process.env.PORT ?? "13000", 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

const server = createServer(async (req, res) => {
  const { matched } = await handler.handle(req, res, {
    context: {
      headers: req.headers,
    },
  });

  if (!matched) {
    res.statusCode = 404;
    res.end("Not Found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Isagi API listening on 127.0.0.1:${port}`);
});
