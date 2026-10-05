// ABOUTME: Объявляет безопасную для TypeScript поверхность owner DTO validator.
// ABOUTME: Wire-типы по-прежнему задают JSON Schema и не копируются сюда.
export declare const schemas: Readonly<Record<string, unknown>>;
export declare const methodMap: Readonly<Record<string, Readonly<Record<string, readonly [params: string, result: string]>>>>;
/** Проверяет имя схемы и значение без преобразования входного DTO. */
export declare function validateDto(name: string, value: unknown): boolean;
/** Возвращает исходное значение либо выбрасывает TypeError без его сериализации. */
export declare function assertDto<T>(name: string, value: T): T;
