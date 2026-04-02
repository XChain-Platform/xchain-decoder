// Minimal mariadb mock for unit tests — prevents ESM import errors.
module.exports = {
    createPool: function () {
        return {
            getConnection: async function () {
                return {
                    query: async function () { return [] },
                    release: async function () {}
                }
            }
        }
    },
    createConnection: async function () {
        return {
            query: async function () { return [] },
            end: async function () {}
        }
    }
}
