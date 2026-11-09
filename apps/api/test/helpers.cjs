// Prisma expõe métodos por Proxy, sem descriptors compatíveis com mock.method.
exports.mockPrisma = function mockPrisma(t, model, method, implementation) {
  const original = model[method];
  const replacement = t.mock.fn(implementation);
  model[method] = replacement;
  t.after(() => {
    model[method] = original;
  });
  return replacement;
};
