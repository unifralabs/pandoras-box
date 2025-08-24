declare module "better-sqlite3" {
    interface DatabaseOptions {
        readonly?: boolean;
        fileMustExist?: boolean;
        timeout?: number;
    }
    export default class Database {
        constructor(filename: string, options?: DatabaseOptions);
        exec(sql: string): void;
        prepare<T = any>(sql: string): Statement<T>;
    }

    interface Statement<T = any> {
        run(params?: T): void;
        get(params?: T): any;
        all(params?: T): any[];
    }
}
