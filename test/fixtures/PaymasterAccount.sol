// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IAccount} from "aa/interfaces/IAccount.sol";
import {PackedUserOperation} from "aa/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// Local-only account harness with the Kernel CALL encoding. This is not a Kernel implementation.
contract PaymasterAccount is IAccount {
    address public immutable entryPoint;
    address public immutable owner;
    constructor(address ep, address accountOwner) {
        require(ep != address(0) && accountOwner != address(0));
        entryPoint = ep;
        owner = accountOwner;
    }
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256) external view returns (uint256) {
        require(msg.sender == entryPoint);
        return ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(hash), op.signature) == owner ? 0 : 1;
    }
    function execute(bytes32 mode, bytes calldata payload) external {
        require(msg.sender == entryPoint && mode == bytes32(0));
        address target = address(bytes20(payload[:20]));
        uint256 value = uint256(bytes32(payload[20:52]));
        (bool ok,) = target.call{value:value}(payload[52:]);
        require(ok);
    }
}

contract PaymasterClaimTarget {
    mapping(address => uint256) public claimed;
    function claim(uint256 amount) external { claimed[msg.sender] += amount; }
}
