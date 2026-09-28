import Fastify, { type FastifyInstance } from "fastify";

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const todos: Todo[] = [];
  let nextId = 1;

  app.get<{ Reply: Todo[] }>("/todos", async () => todos);

  app.post<{ Body: { title?: string }; Reply: Todo | { error: string } }>(
    "/todos",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: "title is required" });
      const todo: Todo = { id: nextId++, title, completed: false };
      todos.push(todo);
      return reply.code(201).send(todo);
    },
  );

  return app;
}
