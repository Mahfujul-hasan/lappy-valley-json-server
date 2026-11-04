const jsonServer = require("json-server");

const server = jsonServer.create();
const router = jsonServer.router("db.json");
const middlewares = jsonServer.defaults();

const port = process.env.PORT || 4000;

server.use(middlewares);
server.use(router);

server.listen(port, "0.0.0.0", () => {
  console.log(`JSON Server running on port ${port}`);
});
