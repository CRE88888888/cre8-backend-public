// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Local fixture for the balance reader's canonical Multicall3 interface.
contract P11Multicall {
    struct Call { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (bool success, bytes memory data) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "required call failed");
            results[i] = Result(success, data);
        }
    }
}
