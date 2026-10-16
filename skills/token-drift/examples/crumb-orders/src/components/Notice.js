import styled from 'styled-components';

export const Notice = styled.div`
  margin: 16px 0;
  padding: 12px 16px;
  border-left: 4px solid #2f9e44;
  border-radius: 4px;
  background: #ebfbee;
  color: #2b8a3e;
  font-size: 14px;
`;

export const ErrorNotice = styled(Notice)`
  border-left-color: #c92a2a;
  background: #fdecea;
  color: #c92a2a;
`;
