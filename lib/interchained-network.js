module.exports = {
    messagePrefix: '\x18Interchained Signed Message:\n',
    bech32: 'itc', // Your prefix
    bip32: {
        public: 0x0488b21e,
        private: 0x0488ade4
    },
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80
};
