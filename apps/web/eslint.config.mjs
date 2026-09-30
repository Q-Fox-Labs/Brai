// ABOUTME: Проверяет TypeScript веб-приложения минимальными правилами ESLint.
// ABOUTME: Сгенерированные и сторонние файлы исключены из проверки.
import tseslint from "typescript-eslint";
export default tseslint.config({ ignores: [".next/**", "node_modules/**", "next-env.d.ts"] }, ...tseslint.configs.recommended);
